import os
import json
import sqlite3
import cv2
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
import google.generativeai as genai
import tempfile
from dtw import dtw
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS

# --- App Setup & Config ---
load_dotenv()
app = Flask(__name__, static_folder='.')
CORS(app)

# --- Gemini API Configuration ---
try:
    # Use GOOGLE_API_KEY for consistency with coach_app,
    # or fallback to GEMINI_API_KEY
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ["GEMINI_API_KEY"]
    genai.configure(api_key=api_key)
    
    text_model = genai.GenerativeModel('gemini-2.5-flash-preview-09-2025')
    json_model = genai.GenerativeModel(
        'gemini-2.5-flash-preview-09-2025',
        generation_config={"response_mime_type": "application/json"}
    )
except KeyError:
    print("Error: GOOGLE_API_KEY or GEMINI_API_KEY environment variable not set.")
    text_model = None
    json_model = None
except Exception as e:
    print(f"Error configuring Gemini: {e}")
    text_model = None
    json_model = None

# --- MoveNet Config & Model Loading (from coach_app) ---
DB_NAME = "correct_movement.db"
INPUT_SIZE = 256 # Thunder model uses 256x256
MIN_CONFIDENCE = 0.3
# --- OPTIMIZATION 1: PROCESS EVERY Nth FRAME ---
# 1 = process every frame (slow)
# 3 = process 1/3 of frames (much faster)
FRAME_SKIP_RATE = 1 


KEYPOINT_DICT = {
    'nose': 0, 'left_eye': 1, 'right_eye': 2, 'left_ear': 3, 'right_ear': 4,
    'left_shoulder': 5, 'right_shoulder': 6, 'left_elbow': 7, 'right_elbow': 8,
    'left_wrist': 9, 'right_wrist': 10, 'left_hip': 11, 'right_hip': 12,
    'left_knee': 13, 'right_knee': 14, 'left_ankle': 15, 'right_ankle': 16
}

METRIC_NAMES = [
    'torso_angle', 'spine_curvature', 'armpit_angle',
    'shoulder_vec_norm', 'elbow_vec_norm', 'hip_vec_norm', 'knee_vec_norm'
]

def load_movenet_model():
    """Load MoveNet model once at startup."""
    print("Loading MoveNet model...")
    
    # --- Using THUNDER MODEL per user request ---
    model_url = "https://tfhub.dev/google/movenet/singlepose/thunder/4"
    
    try:
        module = hub.load(model_url)
        model = module.signatures['serving_default']
        print("MoveNet 'Thunder' model loaded successfully.")
        return model
    except Exception as e:
        print(f"CRITICAL ERROR: Could not load MoveNet model: {e}")
        return None

# Load the model at global scope
movenet_model = load_movenet_model()

# --- Helper Functions (from coach_app) ---

def run_inference(model, frame):
    """Run MoveNet inference on a frame."""
    image_tensor = tf.convert_to_tensor(frame)
    image_tensor = tf.expand_dims(image_tensor, axis=0)
    image_tensor = tf.cast(image_tensor, dtype=tf.int32)
    # Note: INPUT_SIZE is now 256 for Thunder model
    resized_image = tf.image.resize_with_pad(image_tensor, INPUT_SIZE, INPUT_SIZE)
    outputs = model(tf.cast(resized_image, dtype=tf.int32))
    return outputs['output_0'].numpy()[0, 0]

def calc_angle(A, B, C):
    """Calculate angle ABC in degrees."""
    A, B, C = np.array(A), np.array(B), np.array(C)
    BA = A - B
    BC = C - B
    dot_product = np.dot(BA, BC)
    mag_BA = np.linalg.norm(BA)
    mag_BC = np.linalg.norm(BC)
    if mag_BA == 0 or mag_BC == 0:
        return 0.0
    cosine_angle = np.clip(dot_product / (mag_BA * mag_BC), -1.0, 1.0)
    return np.degrees(np.arccos(cosine_angle))

def calc_distance(A, B):
    """Compute Euclidean distance between two points."""
    return np.linalg.norm(np.array(A) - np.array(B))

def get_side_keypoints(kps, side_prefix):
    """Extract keypoints of one body side (left or right)."""
    k = KEYPOINT_DICT
    pts = {
        'shoulder': kps[k[f'{side_prefix}_shoulder']],
        'elbow':    kps[k[f'{side_prefix}_elbow']],
        'wrist':    kps[k[f'{side_prefix}_wrist']],
        'hip':      kps[k[f'{side_prefix}_hip']],
        'knee':     kps[k[f'{side_prefix}_knee']],
        'ankle':    kps[k[f'{side_prefix}_ankle']],
    }
    min_conf = min(
        pts['shoulder'][2], pts['hip'][2], pts['knee'][2], pts['ankle'][2]
    )
    return pts, min_conf

def normalize_vector(vec, scale):
    """Normalize vector using scale factor."""
    if scale == 0:
        return [0.0, 0.0]
    return (vec / scale).tolist()

def process_video_to_metrics(model, video_path):
    """Process video and compute normalized movement metrics."""
    print(f"Processing video: {os.path.basename(video_path)}...")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: Cannot open video {video_path}")
        return None

    all_frame_metrics = []
    frame_count = 0
    processed_frame_count = 0 

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_count += 1
            if frame_count % FRAME_SKIP_RATE != 0:
                continue
                
            processed_frame_count += 1
            
            if processed_frame_count % 10 == 0:
                print(f"--- Processing frame {frame_count} (processed {processed_frame_count}) ---", flush=True)

            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            keypoints_17 = run_inference(model, rgb_frame)

            pts_left, conf_left = get_side_keypoints(keypoints_17, 'left')
            pts_right, conf_right = get_side_keypoints(keypoints_17, 'right')

            pts = pts_right if conf_right > conf_left else pts_left

            if max(conf_left, conf_right) < MIN_CONFIDENCE:
                all_frame_metrics.append(None)
                continue

            p_s = pts['shoulder'][:2]
            p_e = pts['elbow'][:2]
            p_h = pts['hip'][:2]
            p_k = pts['knee'][:2]
            p_a = pts['ankle'][:2]

            try:
                torso_angle = calc_angle(p_s, p_h, p_k)
                angle_hip_ankle = calc_angle(p_s, p_h, p_a)
                
                spine_curvature = abs(angle_hip_ankle - torso_angle)
                armpit_angle = calc_angle(p_e, p_s, p_h)

                torso_length = np.linalg.norm(p_s - p_h)
                if torso_length < 0.01:
                    torso_length = 0.01

                shoulder_vec_norm = normalize_vector(p_s - p_h, torso_length)
                elbow_vec_norm = normalize_vector(p_e - p_s, torso_length)
                hip_vec_norm = normalize_vector(p_h - p_k, torso_length)
                knee_vec_norm = normalize_vector(p_k - p_a, torso_length)

                frame_metrics = [
                    float(torso_angle),
                    float(spine_curvature),
                    float(armpit_angle),
                    shoulder_vec_norm,
                    elbow_vec_norm,
                    hip_vec_norm,
                    knee_vec_norm
                ]
                all_frame_metrics.append(frame_metrics)

            except Exception as e:
                print(f"--- Error processing frame {frame_count}: {e} ---", flush=True)
                all_frame_metrics.append(None)
    
    finally:
        cap.release()
        print(f"Analyzed {processed_frame_count} frames out of {frame_count} total. Extracted {len(all_frame_metrics)} valid sequences.")

    return all_frame_metrics

def get_available_exercises():
    """Load list of available exercises from database."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("SELECT exercise_name FROM GoldenSequences ORDER BY exercise_name ASC")
        exercises = [row[0] for row in cursor.fetchall()]
        conn.close()
        return exercises
    except Exception as e:
        print(f"Database read error: {e}")
        return []

def get_golden_data(exercise_name):
    """Retrieve processed golden-standard metrics from database."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT metric_names, metric_data FROM GoldenSequences WHERE exercise_name = ?",
            (exercise_name,)
        )
        row = cursor.fetchone()
        conn.close()
    except Exception as e:
        print(f"Error reading from DB {DB_NAME}: {e}")
        return {}

    if row:
        metric_names = json.loads(row[0])
        metric_data = json.loads(row[1])

        golden_metrics_dict = {}
        for i, name in enumerate(metric_names):
            golden_metrics_dict[name] = [
                frame[i] if frame is not None else None
                for frame in metric_data
            ]
        return golden_metrics_dict

    return {}

def normalize_sequence_zscore(track_data):
    """Z-score normalize a metric sequence."""
    track_np = np.array(track_data)
    mean = np.mean(track_np, axis=0)
    std = np.std(track_np, axis=0)
    std[std == 0] = 1
    return (track_np - mean) / std

def calculate_dtw_error(golden_track, user_track):
    """Compute DTW error between two sequences."""
    g_track = [t for t in golden_track if t is not None]
    u_track = [t for t in user_track if t is not None]

    if len(g_track) < 10 or len(u_track) < 10:
        return 0.0

    try:
        norm_golden = normalize_sequence_zscore(g_track)
        norm_user = normalize_sequence_zscore(u_track)
        alignment = dtw(norm_golden, norm_user, keep_internals=True)
        return alignment.normalizedDistance
    except Exception as e:
        print(f"DTW calculation error: {e}")
        return 0.0

def calculate_scores_v5(golden_metrics, user_metrics, exercise_name):
    """Compute 4 category scores + final score (v5.1 rules)."""
    scores = {
        'Spine Score': 0,
        'Stability Score': 0,
        'Joint Score': 0,
        'Control Score': 0,
        'Final Score': 0
    }

    user_spine_curve = [
        m for m in user_metrics.get('spine_curvature', [])
        if m is not None
    ]
    avg_curvature = np.mean(user_spine_curve) if user_spine_curve else 26

    if avg_curvature <= 15:
        scores['Spine Score'] = 100
    elif avg_curvature <= 20:
        scores['Spine Score'] = 60
    elif avg_curvature <= 25:
        scores['Spine Score'] = 30
    else:
        scores['Spine Score'] = 0

    stability_errors = []
    for vec_name in ['shoulder_vec_norm', 'hip_vec_norm']:
        stability_errors.append(
            calculate_dtw_error(
                golden_metrics.get(vec_name, []),
                user_metrics.get(vec_name, [])
            )
        )

    avg_stability_dtw = np.mean(stability_errors) if stability_errors else 0.0
    scores['Stability Score'] = int(100 - min(avg_stability_dtw * 33.3, 100))

    joint_score = 100
    if 'press' in exercise_name or 'dip' in exercise_name:
        u_armpit = [
            a for a in user_metrics.get('armpit_angle', [])
            if a is not None
        ]
        if u_armpit:
            avg_armpit_angle = np.mean(u_armpit)
            if avg_armpit_angle > 85:
                joint_score = 20
            elif avg_armpit_angle > 75:
                joint_score = 60

    scores['Joint Score'] = int(joint_score)

    control_dtw = 0.0
    if 'curl' in exercise_name or 'raise' in exercise_name:
        control_dtw = calculate_dtw_error(
            golden_metrics.get('elbow_vec_norm', []),
            user_metrics.get('elbow_vec_norm', [])
        )
    elif 'squat' in exercise_name:
        control_dtw = calculate_dtw_error(
            golden_metrics.get('knee_vec_norm', []),
            user_metrics.get('knee_vec_norm', [])
        )

    scores['Control Score'] = int(100 - min(control_dtw * 50, 100))

    final_score = (
        scores['Stability Score'] * 0.35 +
        scores['Spine Score'] * 0.35 +
        scores['Joint Score'] * 0.20 +
        scores['Control Score'] * 0.10
    )

    scores['Final Score'] = int(final_score)

    scores['avg_spine_curvature_user'] = round(avg_curvature, 2)
    scores['avg_stability_dtw_error'] = round(avg_stability_dtw, 2)

    return scores

def call_gemini_for_analysis(exercise_name, scores):
    """Send computed scores to Gemini for analysis."""
    # We use the globally defined `text_model`
    if not text_model:
        print("Gemini text_model not available.")
        return None

    scores_str = json.dumps(scores, indent=2)

    prompt = f"""
    You are a professional AI Coach of JIMBO (v5.1). 
    Your role is to interpret the 4 computed scoring categories.

    **INPUT DATA (Already Computed):**
    {scores_str}

    **HOW TO READ SCORES (v5.1):**
    1. Final Score: The overall score (0-100).
    2. Spine Score (35% weight): Based on `avg_spine_curvature_user` (degrees).
       * 100 (<15° - GOOD)
       * 60 (15-20° - ACCEPTABLE)
       * 30 (20-25° - ERROR)
       * 0   (>25° - CRITICAL ERROR)
    3. Stability Score (35% weight): Based on `avg_stability_dtw_error`. Higher DTW = lower stability.
    4. Joint Score (20% weight): Based on joint behavior (e.g., elbow flare).
    5. Control Score (10% weight): Based on primary joint DTW (e.g., elbow/knee).

    **OUTPUT FORMAT (Do not change structure, fill in the brackets):**
    (Keep the output structure and text concise.)

    ```markdown
    ### 1. OVERVIEW ASSESSMENT
    * **Classification:** [Choose ONE based on Final Score: EXCELLENT (90-100), GOOD (75-89), FAIR (60-74), AVERAGE (40-59), WEAK (<40)]
    * **General Comment:** [1-2 sentences describing strongest/weakest points.]

    ### 2. DETAILED ERROR ANALYSIS

    **A. SPINE SCORE: [Spine Score]/100**
    * **Analysis:** [Explain score. Example: "Score 60/100. Your average spine curvature is [avg_spine_curvature_user] degrees, which is in the 'Acceptable' range (15-20°)."]
    * **Conclusion:** [If score < 100 → "NEEDS IMPROVEMENT", else → "GOOD."]

    **B. STABILITY SCORE: [Stability Score]/100**
    * **Analysis:** ["Score 80/100. Average DTW error for shoulder and hip trajectory is [avg_stability_dtw_error]."]
    * **Conclusion:** [If <70 → "NEEDS IMPROVEMENT", else → "GOOD."]

    **C. JOINT SCORE: [Joint Score]/100**
    * **Analysis:** [If 'press' exercise and low score → "Detected elbow flare." Otherwise → "No significant joint issue detected."]
    * **Conclusion:** [If <70 → "NEEDS IMPROVEMENT", else → "GOOD."]

    **D. CONTROL SCORE: [Control Score]/100**
    * **Analysis:** [If curl/raise/squat and low score → "Detected rhythm control issue (cheat form)." Otherwise → "Good movement rhythm."]
    * **Conclusion:** [If <70 → "NEEDS IMPROVEMENT", else → "GOOD."]

    ### 3. CORRECTIVE ACTIONS
    * [Fix suggestion #1 based on the lowest score]
    * [Fix suggestion #2 based on second lowest score]
    ```
    """

    try:
        response = text_model.generate_content(prompt)
        return response.text
    except Exception as e:
        print(f"Gemini API call error: {e}")
        return None

# === FRONTEND HOSTING (from original app.py) ===

@app.after_request
def add_coop_header(response):
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups'
    return response

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static_files(path):
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory('.', path)
    else:
        # This is a basic fallback.
        return "File not found", 404

# === CONFIG ENDPOINT (from original app.py) ===
@app.route('/config')
def get_config():
    try:
        client_id = os.environ["GOOGLE_CLIENT_ID"]
        return jsonify({"google_client_id": client_id})
    except KeyError:
        print("Error: GOOGLE_CLIENT_ID environment variable not set.")
        return jsonify({"error": "Server configuration error: Missing GOOGLE_CLIENT_ID"}), 500
    except Exception as e:
        print(f"Error in /config: {e}")
        return jsonify({"error": "Server error."}), 500

# === AI GENERATOR ENDPOINTS ===

WORKOUT_SYSTEM_PROMPT = """
You are a world-class personal trainer and nutrition coach named Jimbo. Your goal is to create a detailed, balanced, and effective workout plan for the user based on their inputs.
You MUST reply with a valid JSON object.

The JSON object must have this exact schema:
{
  "title": "Your [Goal] Workout Plan",
  "frequency": "[Days/Week] Training Days",
  "days": [
    {
      "day": "Day 1",
      "focus": "[Muscle Group/Focus]",
      "warm_up": "[Warm-up Exercises]",
      "exercises": [
        {
          "name": "[Exercise 1]",
          "sets_reps": "[Sets x Reps]"
        },
        {
          "name": "[Exercise 2]",
          "sets_reps": "[Sets x Reps]"
        }
      ],
      "cool_down": "[Cool-down Exercises]"
    }
  ],
  "motivational_tip": "[A short, punchy motivational tip]"
}

Follow these rules:
1.  **JSON ONLY:** Your entire response must be a single, valid JSON object. Do not include any text before or after the JSON.
2.  **Schema:** Adhere strictly to the JSON schema provided above.
3.  **Plan Logic:**
    * `goal`: Use this to determine the rep ranges (e.g., Strength: 3-5 reps, Muscle Gain: 8-12 reps, Endurance: 15+ reps, Fat Loss: 10-15 reps).
    * `experience_level`: Adjust complexity. Beginners get simple machine/dumbbell exercises. Advanced users get complex compound lifts and isolation work.
    * `days_per_week`: Create a plan with this many "day" objects. A 3-day plan should have 3 objects in the "days" array.
    * `available_equipment`: ONLY use exercises possible with this equipment. "Full gym" means all standard equipment. "Dumbbells" means only dumbbell exercises.
4.  **Content:**
    * `focus`: Be specific (e.g., "Full Body", "Push Day (Chest, Shoulders, Triceps)", "Legs & Core").
    * `warm_up` & `cool_down`: Provide 1-2 simple exercises (e.g., "5-10 min light cardio", "Dynamic stretches", "Static stretches").
    * `sets_reps`: Be precise (e.g., "3 sets x 8-10 reps", "4 sets x 5 reps").
""" 

NUTRITION_SYSTEM_PROMPT = """
You are an expert nutritionist (Jimbo). Your goal is to create a simple, effective, and high-level nutrition plan for the user.
You MUST reply with a valid JSON object.

The JSON object must have this exact schema:
{
  "title": "Your [Goal] Nutrition Plan",
  "targets": {
    "calories": "[Calories]",
    "protein": "[Protein in g]",
    "carbs": "[Carbs in g]",
    "fats": "[Fats in g]"
  },
  "sample_plan": [
    {
      "meal": "Breakfast",
      "description": "[A brief example meal]"
    },
    {
      "meal": "Lunch",
      "description": "[A brief example meal]"
    },
    {
      "meal": "Dinner",
      "description": "[A brief example meal]"
    },
    {
      "meal": "Snack",
      "description": "[A brief example snack]"
    }
  ],
  "key_tips": [
    "[Tip 1]",
    "[Tip 2]",
    "[Tip 3]"
  ]
}

Follow these rules:
1.  **JSON ONLY:** Your entire response must be a single, valid JSON object.
2.  **Schema:** Adhere strictly to the JSON schema.
3.  **Calculations:**
    * Calculate estimated BMR (Harris-Benedict or Mifflin-St Jeor) and TDEE based on weight, height, age, and activity level.
    * Adjust TDEE for the user's goal:
        * `Fat Loss`: TDEE - 500 calories
        * `Muscle Gain`: TDEE + 300-500 calories
        * `Maintenance`: TDEE
    * Set macronutrients:
        * Protein: 1.6-2.2g per kg of body weight.
        * Fats: 20-30% of total calories.
        * Carbs: Remaining calories.
    * Round all values to be reasonable.
4.  **Content:**
    * `sample_plan`: Provide simple, balanced meal examples.
    * `key_tips`: Give 3 scannable, high-impact tips (e.g., "Prioritize protein at each meal", "Drink 2-3L of water daily", "Limit processed foods").
    * `preferences`: If the user provides preferences (e.g., "vegetarian"), all meal examples must follow this.
""" 

EVALUATION_SYSTEM_PROMPT = """
You are an AI Personal Training Coach (Jimbo). The user is providing their original workout plan and a series of check-ins. Your job is to analyze their progress and provide a concise, motivational evaluation.
You MUST reply with a valid JSON object.

The JSON object must have this exact schema:
{
  "title": "Your Progress Evaluation",
  "analysis": "[A short paragraph (2-3 sentences) summarizing their progress against their plan. Start by acknowledging their consistency.]",
  "key_observations": [
    "[Observation 1 based on notes/weight, e.g., 'Great job logging 3 sessions this week!']",
    "[Observation 2 based on notes/weight, e.g., 'Weight is trending down, which aligns with your fat loss goal.']"
  ],
  "recommendations": [
    "[Recommendation 1, e.g., 'Keep consistency high.']",
    "[Recommendation 2, e.g., 'If strength stalls, consider increasing weight on your main lifts.']"
  ]
}

Follow these rules:
1.  **JSON ONLY:** Your entire response must be a single, valid JSON object.
2.  **Schema:** Adhere strictly to the JSON schema.
3.  **Tone:** Be positive, motivational, and constructive.
4.  **Analysis:**
    * Read the user's `original_plan` to see their goal.
    * Read the `check_ins` (a list of objects) to see their `notes` and `weight_kg`.
    * Compare their check-in notes and weight changes to their goal.
    * `analysis`: Comment on their consistency and results.
    * `key_observations`: Pick 2 positive things from their check-ins.
    * `recommendations`: Give 2 simple, actionable tips.
"""

CHAT_SYSTEM_PROMPT = """
You are Jimbo, an AI Personal Trainer.
A user has just generated a plan and has some follow-up questions.
Your task is to answer their questions based *only* on the plan provided and the chat history.
Be helpful, concise, and stay in character.

**CONTEXT - THE USER'S PLAN:**
{context_plan}

**CHAT HISTORY (So Far):**
{chat_history}

**USER'S NEW QUESTION:**
{user_message}

**YOUR ANSWER:**
"""

@app.route('/generate-workout', methods=['POST'])
def generate_workout_v2():
    if not json_model:
        return jsonify({"error": "Gemini API not configured"}), 500

    data = request.get_json()
    required_fields = ['goal', 'experience_level', 'days_per_week', 'hours_per_day', 'available_equipment']
    if not all(field in data for field in required_fields):
        return jsonify({"error": "Missing required fields"}), 400

    user_prompt = f"""
    Goal: {data['goal']}
    Experience: {data['experience_level']}
    Days/Week: {data['days_per_week']}
    Hours/Day: {data['hours_per_day']}
    Equipment: {data['available_equipment']}
    Notes: {data.get('notes', 'None')}
    """
    
    try:
        response = json_model.generate_content([WORKOUT_SYSTEM_PROMPT, user_prompt])
        plan_json = json.loads(response.text)
        return jsonify(plan_json), 200
    except Exception as e:
        print(f"Gemini Error: {e}")
        return jsonify({"error": "Failed to generate plan from AI."}), 500


@app.route('/generate-nutrition-plan', methods=['POST'])
def generate_nutrition_v2():
    if not json_model:
        return jsonify({"error": "Gemini API not configured"}), 500
        
    data = request.get_json()

    user_prompt = f"""
    Goal: {data['goal']}
    Weight: {data['weight_kg']} kg
    Height: {data['height_cm']} cm
    Age: {data['age']}
    Activity Level: {data['activity_level']}
    Preferences: {data.get('preferences', 'None')}
    """
    
    try:
        response = json_model.generate_content([NUTRITION_SYSTEM_PROMPT, user_prompt])
        plan_json = json.loads(response.text)
        return jsonify(plan_json), 200
    except Exception as e:
        print(f"Gemini Error: {e}")
        return jsonify({"error": "Failed to generate nutrition plan from AI."}), 500

@app.route('/evaluate-plan', methods=['POST'])
def evaluate_plan():
    if not json_model:
        return jsonify({"error": "Gemini API not configured"}), 500

    data = request.get_json()
    if not data or 'original_plan' not in data or 'check_ins' not in data:
         return jsonify({"error": "Missing 'original_plan' or 'check_ins' data in request"}), 400

    original_plan = data['original_plan']
    check_ins_list = data['check_ins']

    if not original_plan:
        return jsonify({"error": "No saved plan found. Please save a plan first."}), 400
    if not check_ins_list:
        return jsonify({"error": "No check-ins found. Please log your progress first."}), 400

    user_prompt = f"""
    Here is my original plan:
    {json.dumps(original_plan, indent=2)}

    And here are all my check-ins:
    {json.dumps(check_ins_list, indent=2)}
    
    Please evaluate my progress.
    """

    try:
        response = json_model.generate_content([EVALUATION_SYSTEM_PROMPT, user_prompt])
        evaluation_json = json.loads(response.text)
        return jsonify(evaluation_json), 200
    except Exception as e:
        print(f"Gemini Error: {e}")
        return jsonify({"error": "Failed to evaluate progress from AI."}), 500

@app.route('/chat-with-plan', methods=['POST'])
def chat_with_plan():
    if not text_model:
        return jsonify({"error": "Gemini text model not configured"}), 500

    data = request.get_json()
    if not data or 'context_plan' not in data or 'message' not in data:
         return jsonify({"error": "Missing 'context_plan' or 'message' data"}), 400

    context_plan = json.dumps(data['context_plan'], indent=2)
    user_message = data['message']
    
    # Handle chat history
    history = data.get('history', [])
    history_str = "\n".join([f"{msg['role']}: {msg['content']}" for msg in history])

    prompt = CHAT_SYSTEM_PROMPT.format(
        context_plan=context_plan,
        chat_history=history_str,
        user_message=user_message
    )

    try:
        response = text_model.generate_content(prompt)
        return jsonify({"response": response.text}), 200
    except Exception as e:
        print(f"Gemini Chat Error: {e}")
        return jsonify({"error": "Failed to get chat response from AI."}), 500

# === VIDEO ANALYSIS ENDPOINTS ===

@app.route('/exercises', methods=['GET'])
def list_exercises():
    """Endpoint to get the list of available exercises."""
    try:
        exercises = get_available_exercises()
        if not exercises:
            # Check if DB file exists
            if not os.path.exists(DB_NAME):
                 return jsonify({"error": f"Database file '{DB_NAME}' not found."}), 404
            return jsonify({"error": "No exercises found in database."}), 404
        return jsonify(exercises), 200
    except Exception as e:
        print(f"Error in /exercises: {e}")
        return jsonify({"error": "Failed to retrieve exercises from database."}), 500


# --- STREAMING ANALYSIS FUNCTION ---
def _analyze_video_stream(temp_video_path, exercise_name):
    """
    A generator function that yields progress updates
    for the video analysis process.
    """
    try:    
        # 1. Process User Video
        yield json.dumps({
            "status": "processing_video", 
            "message": "Analyzing video frames (MoveNet)...", 
            "percent": 10
        }) + "\n"
        
        user_metrics_list = process_video_to_metrics(
            movenet_model, temp_video_path
        )
        if not user_metrics_list:
            raise Exception("Video processing failed. Could not extract metrics.")

        # 2. Get Golden Standard Data
        yield json.dumps({
            "status": "loading_golden", 
            "message": "Loading golden standard data...", 
            "percent": 65
        }) + "\n"

        golden_metrics_dict = get_golden_data(exercise_name)
        if not golden_metrics_dict:
            raise Exception(f"Golden-standard data not found for '{exercise_name}'.")

        # 3. Format User Metrics (quick step)
        user_metrics_dict = {}
        for i, name in enumerate(METRIC_NAMES):
            user_metrics_dict[name] = [
                frame[i] if frame is not None else None
                for frame in user_metrics_list
            ]

        # 4. Calculate Scores
        yield json.dumps({
            "status": "calculating_scores", 
            "message": "Comparing your form (DTW)...", 
            "percent": 75
        }) + "\n"

        scores = calculate_scores_v5(
            golden_metrics_dict, user_metrics_dict, exercise_name
        )

        # 5. Get Gemini Analysis
        yield json.dumps({
            "status": "calling_ai", 
            "message": "Getting feedback from AI Coach...", 
            "percent": 90
        }) + "\n"

        analysis_result = call_gemini_for_analysis(
            exercise_name, scores
        )
        if not analysis_result:
            raise Exception("Failed to get AI analysis.")

        # 6. Return combined results
        final_data = {
            "scores": scores,
            "analysis_markdown": analysis_result
        }
        yield json.dumps({
            "status": "complete", 
            "message": "Analysis complete!", 
            "percent": 100,
            "data": final_data
        }) + "\n"

    except Exception as e:
        print(f"Error in analysis stream: {e}")
        # Yield a final error message to the client
        yield json.dumps({
            "status": "error", 
            "message": str(e),
            "percent": 100
        }) + "\n"
    
    finally:
        # Clean up the temporary file *after* the stream is done
        if temp_video_path and os.path.exists(temp_video_path):
            os.remove(temp_video_path)
            print(f"Cleaned up temp file: {temp_video_path}")

@app.route('/analyze-form', methods=['POST'])
def analyze_video_form():
    """
    Endpoint to analyze an uploaded video form.
    This now returns a streaming response.
    """
    if not movenet_model:
        return jsonify({"error": "MoveNet model is not loaded. Cannot process video."}), 500

    if 'video' not in request.files:
        return jsonify({"error": "No 'video' file part in request."}), 400
    
    file = request.files['video']
    if file.filename == '':
        return jsonify({"error": "No selected video file."}), 400

    exercise_name = request.form.get('exercise_name')
    if not exercise_name:
        return jsonify({"error": "Missing 'exercise_name' form field."}), 400

    # --- Save the file *before* starting the generator ---
    temp_video_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as tfile:
            file.save(tfile.name)
            temp_video_path = tfile.name
    except Exception as e:
        print(f"Critical error saving temp file: {e}")
        return jsonify({"error": f"Failed to save uploaded file: {e}"}), 500

    # Return the streaming response
    # We pass the *path* (string) to the generator, not the file object
    return Response(
        stream_with_context(_analyze_video_stream(temp_video_path, exercise_name)), 
        mimetype='application/x-json-stream'
    )


# === Main Run ===
if __name__ == '__main__':
    # Ensure the database exists before running
    if not os.path.exists(DB_NAME):
        print(f"Warning: Database file '{DB_NAME}' not found.")
        print("The /exercises and /analyze-form endpoints will fail.")
        print("Please create the 'correct_movement.db' file.")
    
    app.run(debug=True, port=5000)