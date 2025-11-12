import os
import json
import google.generativeai as genai
from dotenv import load_dotenv
# --- FIX IS ON THIS LINE ---
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS

# --- App Setup & Config ---
load_dotenv()
# --- UPDATED THIS LINE ---
# We set static_folder='.' to tell Flask the current directory
# is where static files (like index.html) live.
app = Flask(__name__, static_folder='.')
CORS(app)

# --- Gemini API Configuration ---
try:
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    text_model = genai.GenerativeModel('gemini-2.5-flash-preview-09-2025')
    json_model = genai.GenerativeModel(
        'gemini-2.5-flash-preview-09-2025',
        generation_config={"response_mime_type": "application/json"}
    )
except KeyError:
    print("Error: GEMINI_API_KEY environment variable not set.")
    text_model = None
    json_model = None
except Exception as e:
    print(f"Error configuring Gemini: {e}")
    text_model = None
    json_model = None
# === NEW: FRONTEND HOSTING ===

# This is the magic fix. We create a middleware to add the
# 'Cross-Origin-Opener-Policy' header to *every* response.
@app.after_request
def add_coop_header(response):
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups'
    return response

# This new route serves your index.html file
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

# This route serves any other files your HTML might need (like images)
@app.route('/<path:path>')
def serve_static_files(path):
    # Check if the file exists in the static folder (which we set to '.')
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory('.', path)
    else:
        # If the file doesn't exist, it's probably an API route,
        # but we'll let other routes handle it.
        # This is a simple fallback.
        return "File not found", 404

# === NEW CONFIG ENDPOINT ===
# This endpoint securely sends the Google Client ID to the frontend
@app.route('/config')
def get_config():
    try:
        # Read the Google Client ID from the environment
        client_id = os.environ["GOOGLE_CLIENT_ID"]
        return jsonify({"google_client_id": client_id})
    except KeyError:
        print("Error: GOOGLE_CLIENT_ID environment variable not set. Please add it to your .env file.")
        return jsonify({"error": "Server configuration error: Missing GOOGLE_CLIENT_ID"}), 500
    except Exception as e:
        print(f"Error in /config: {e}")
        return jsonify({"error": "Server error."}), 500


# === AI GENERATOR ENDPOINTS ===
# (These are now open, no auth required)

WORKOUT_SYSTEM_PROMPT = """
You are a world-class personal trainer. A user will provide their stats.
You MUST generate a complete, structured workout plan in JSON format.
You MUST adhere to the JSON schema provided.
The user's 'hours_per_day' is a hard limit.
Schema:
{
  "title": "Workout Plan for [User's Goal]",
  "frequency": "[X] days per week",
  "days": [
    {
      "day": "Day 1",
      "focus": "e.g., Full Body or Upper Body (Push)",
      "warm_up": "5-10 minutes...",
      "exercises": [
        {"name": "Exercise Name", "sets_reps": "3 sets of 8-12 reps"},
        {"name": "Exercise Name", "sets_reps": "4 sets of 5 reps"}
      ],
      "cool_down": "5 minutes static stretching."
    }
  ],
  "motivational_tip": "A short, punchy tip."
}
"""

NUTRITION_SYSTEM_PROMPT = """
You are an expert nutritionist. A user will provide their stats.
You MUST generate a complete, structured nutrition plan in JSON format.
You MUST adhere to the JSON schema provided.
Schema:
{
  "title": "Nutrition Plan for [User's Goal]",
  "targets": {
    "calories": "Approx [XXXX] kcal/day",
    "protein": "Approx [XXX]g/day",
    "carbs": "Approx [XXX]g/day",
    "fats": "Approx [XXX]g/day"
  },
  "sample_plan": [
    {"meal": "Breakfast", "description": "e.g., 3 eggs, 1 cup oatmeal..."},
    {"meal": "Lunch", "description": "e.g., 150g chicken breast, 1 cup quinoa..."},
    {"meal": "Dinner", "description": "e.g., 150g salmon, 2 cups broccoli..."}
  ],
  "key_tips": [
    "Tip 1, e.g., Drink at least 3L of water per day.",
    "Tip 2, e.g., Prioritize protein in every meal."
  ]
}
"""

EVALUATION_SYSTEM_PROMPT = """
You are an AI Personal Training Coach.
A user will provide their original workout plan and a series of check-in logs.
Your task is to analyze their progress and provide a concise evaluation.
You MUST return the evaluation in the specified JSON format.
Schema:
{
  "title": "Your Progress Evaluation",
  "analysis": "A 1-2 paragraph summary of their overall progress, adherence, and results based on their check-ins (e.g., weight changes, self-reported feelings).",
  "key_observations": [
    "A positive observation (e.g., 'Great consistency on your workouts!')",
    "An observation on results (e.g., 'Your weight is trending down, which aligns with your fat loss goal.')",
    "An observation on challenge (e.g., 'You mentioned 'Day 3' was very tough, this is normal.')"
  ],
  "recommendations": [
    "A specific, actionable recommendation (e.g., 'Since you're feeling stronger, try increasing the weight on your Squats by 2.5kg next week.')",
    "Another recommendation (e.g., 'Consider adding a 10-minute walk on your rest days to help with recovery.')"
  ]
}
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
    # ... (add required field check)
    
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
    if not data or 'plan' not in data or 'check_ins' not in data:
         return jsonify({"error": "Missing 'plan' or 'check_ins' data in request"}), 400

    # The frontend now sends the data, so we don't need to look it up
    original_plan = data['plan']
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

# === Main Run ===
if __name__ == '__main__':
    app.run(debug=True, port=5000)