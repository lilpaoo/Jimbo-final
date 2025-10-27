import os
from dotenv import load_dotenv
import google.generativeai as genai
from flask import Flask, request, jsonify, abort
from flask_cors import CORS  # <-- NEW: Import CORS
import json

load_dotenv()

# Initialize the Flask app and enable CORS
app = Flask(__name__)
CORS(app)  # <-- NEW: Enable CORS for all routes

# --- Gemini API Configuration ---
# The app will now find the key loaded from your .env file
try:
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
except KeyError:
    print("Error: GEMINI_API_KEY not found. Make sure it's set in your .env file.")
except Exception as e:
    print(f"An error occurred during Gemini configuration: {e}")

# --- NEW: Configure the model to output JSON ---
generation_config = {
    "response_mime_type": "application/json",
}
model = genai.GenerativeModel(
    'gemini-2.5-flash-preview-09-2025',
    generation_config=generation_config
)


# --- System Instruction for AI (Workout) ---
# This prompt now requests a specific JSON schema
WORKOUT_SYSTEM_PROMPT = """
You are "FitBot", an expert AI personal trainer. You MUST return your response as a valid JSON object.
Do not include any text outside of the JSON structure.

Here is the JSON schema you must follow:
{
  "title": "Workout Plan for [User's Goal]",
  "frequency": "[Days per week]",
  "days": [
    {
      "day": "Day 1",
      "focus": "[Focus, e.g., Full Body Strength A]",
      "warm_up": "[Warm-up description, e.g., 5-10 minutes light cardio]",
      "exercises": [
        { "name": "[Exercise Name]", "sets_reps": "[e.g., 3 sets of 8-12 reps]" },
        { "name": "[Exercise Name]", "sets_reps": "[e.g., 3 sets of 10-15 reps]" }
      ],
      "cool_down": "[Cool-down description, e.g., 5 minutes static stretching]"
    }
  ],
  "motivational_tip": "[A brief motivational tip]"
}

Base the plan on the user's details. Ensure the "days" array contains an object for each workout day.
**Pay close attention to the user's 'Hours Per Day' and adjust the number of exercises (volume) to fit that timeframe.**
"""

# --- System Instruction for AI (Nutrition) ---
# This prompt now requests a specific JSON schema
NUTRITION_SYSTEM_PROMPT = """
You are "NutriBot", an expert AI nutritionist. You MUST return your response as a valid JSON object.
Do not include any text outside of the JSON structure.

Here is the JSON schema you must follow:
{
  "title": "Nutrition Plan for [User's Goal]",
  "targets": {
    "calories": "[Estimated Daily Calorie Target, e.g., ~2100 kcal]",
    "protein": "[Protein target, e.g., ~170g]",
    "carbs": "[Carbs target, e.g., ~190g]",
    "fats": "[Fats target, e.g., ~70g]"
  },
  "sample_plan": [
    { "meal": "Breakfast", "description": "[Meal Example]" },
    { "meal": "Lunch", "description": "[Meal Example]" },
    { "meal": "Dinner", "description": "[Meal Example]" },
    { "meal": "Snacks", "description": "[Snack Example]" }
  ],
  "key_tips": [
    "[Tip 1, e.g., Drink at least 8 glasses of water...]",
    "[Tip 2, e.g., Focus on whole, unprocessed foods...]",
    "[Tip 3, e.g., Adjust portion sizes based on hunger and results...]"
  ]
}

Base the plan on the user's details. Provide 3-5 key tips.
"""

# --- NEW: System Instruction for AI (Evaluator) ---
EVALUATOR_SYSTEM_PROMPT = """
You are "CoachBot", an expert AI personal trainer and evaluator.
You will receive a user's original plan and a series of check-ins.
Your job is to analyze their progress and provide a concise, actionable evaluation in JSON format.
Do not include any text outside of the JSON structure.

Here is the JSON schema you must follow:
{
  "title": "Progress Evaluation",
  "analysis": "[Your overall analysis of their consistency and progress based on the check-ins]",
  "key_observations": [
    "[Observation 1, e.g., 'Great consistency on weigh-ins!']",
    "[Observation 2, e.g., 'You seem to be missing your Day 3 workout frequently.']",
    "[Observation 3, e.g., 'Weight is trending downwards as planned.']"
  ],
  "recommendations": [
    "[Recommendation 1, e.g., 'Keep up the great work on nutrition.']",
    "[Recommendation 2, e.g., 'If Day 3 is difficult, let's try moving that workout to Day 4.']"
  ]
}
"""


# --- API Endpoints ---

@app.route('/')
def home():
    """A simple route to check if the API is running."""
    return "Personal Trainer AI API is running!"

@app.route('/generate-workout', methods=['POST'])
def generate_workout():
    """
    The main endpoint to generate a workout plan.
    Expects a JSON payload with user details.
    """
    if not request.json:
        abort(400, description="Missing JSON payload.")

    data = request.json
    
    # --- Input Validation ---
    required_fields = ['goal', 'experience_level', 'days_per_week', 'hours_per_day', 'available_equipment']
    missing_fields = [field for field in required_fields if field not in data]
    
    if missing_fields:
        return jsonify({"error": f"Missing required fields: {', '.join(missing_fields)}"}), 400

    # --- Construct the User Prompt ---
    user_prompt = f"""
    Please create a personalized workout plan for me. Here are my details:
    - **My Goal:** {data.get('goal')}
    - **My Experience Level:** {data.get('experience_level')}
    - **Days Per Week:** {data.get('days_per_week')}
    - **Hours Per Day:** {data.get('hours_per_day')}
    - **Available Equipment:** {data.get('available_equipment')}
    - **Any Other Notes (optional):** {data.get('notes', 'None')}
    """

    print(f"Generating workout for: {data.get('goal')}")

    try:
        # --- Call the Gemini API ---
        # We combine the system prompt and user prompt for a complete context
        full_prompt = WORKOUT_SYSTEM_PROMPT + "\n\n--- USER REQUEST ---\n\n" + user_prompt
        
        response = model.generate_content(full_prompt)
        
        # Check if the response has text
        if not response.parts:
            raise ValueError("Received an empty response from the AI model.")
            
        # --- NEW: Parse the JSON string from the AI ---
        # The AI's 'text' is now a JSON string. We parse it into a Python dict.
        workout_plan_json = json.loads(response.text)

        # Return the parsed JSON object directly.
        # Flask will automatically send this as an application/json response.
        return jsonify(workout_plan_json)

    except json.JSONDecodeError:
        print(f"Error: Failed to decode JSON from AI response: {response.text}")
        return jsonify({"error": "Failed to parse AI response. Please try again."}), 500
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        # Check for API key issues specifically
        if "API_KEY" in str(e):
             return jsonify({"error": "Failed to generate workout. Is the GEMINI_API_KEY environment variable set correctly?"}), 500
        
        return jsonify({"error": f"An internal error occurred: {e}"}), 500

@app.route('/generate-nutrition-plan', methods=['POST'])
def generate_nutrition_plan():
    """
    The endpoint to generate a nutrition plan.
    Expects a JSON payload with user details.
    """
    if not request.json:
        abort(400, description="Missing JSON payload.")

    data = request.json
    
    # --- Input Validation (based on your point #2) ---
    required_fields = ['goal', 'weight_kg', 'height_cm', 'age', 'activity_level']
    missing_fields = [field for field in required_fields if field not in data]
    
    if missing_fields:
        return jsonify({"error": f"Missing required fields: {', '.join(missing_fields)}"}), 400

    # --- Construct the User Prompt ---
    user_prompt = f"""
    Please create a personalized nutrition plan for me. Here are my details:
    - **My Goal:** {data.get('goal')} (e.g., Fat Loss, Muscle Gain, Maintenance)
    - **Current Weight:** {data.get('weight_kg')} kg
    - **Height:** {data.get('height_cm')} cm
    - **Age:** {data.get('age')}
    - **Activity Level:** {data.get('activity_level')} (e.g., Sedentary, Lightly Active, Moderately Active, Very Active)
    - **Dietary Preferences (optional):** {data.get('preferences', 'None')}
    """

    print(f"Generating nutrition plan for: {data.get('goal')}")

    try:
        # --- Call the Gemini API ---
        # We combine the nutrition system prompt and user prompt
        full_prompt = NUTRITION_SYSTEM_PROMPT + "\n\n--- USER REQUEST ---\n\n" + user_prompt
        
        response = model.generate_content(full_prompt)
        
        # Check if the response has text
        if not response.parts:
            raise ValueError("Received an empty response from the AI model.")
            
        # --- NEW: Parse the JSON string from the AI ---
        nutrition_plan_json = json.loads(response.text)

        # Return the parsed JSON object directly.
        return jsonify(nutrition_plan_json)
        
    except json.JSONDecodeError:
        print(f"Error: Failed to decode JSON from AI response: {response.text}")
        return jsonify({"error": "Failed to parse AI response. Please try again."}), 500
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        if "API_KEY" in str(e):
             return jsonify({"error": "Failed to generate nutrition plan. Is the GEMINI_API_KEY environment variable set correctly?"}), 500
        
        return jsonify({"error": f"An internal error occurred: {e}"}), 500

# --- NEW: EVALUATION ENDPOINT ---
@app.route('/evaluate-plan', methods=['POST'])
def evaluate_plan():
    """
    The endpoint to evaluate a user's progress.
    Expects a JSON payload with the original plan and a list of check-ins.
    """
    if not request.json:
        abort(400, description="Missing JSON payload.")

    data = request.json
    
    # --- Input Validation ---
    required_fields = ['original_plan', 'check_ins']
    missing_fields = [field for field in required_fields if field not in data]
    
    if missing_fields:
        return jsonify({"error": f"Missing required fields: {', '.join(missing_fields)}"}), 400

    # --- Construct the User Prompt ---
    # We serialize the plan and check-ins so the AI can read them
    user_prompt = f"""
    Here is my original plan and all my check-ins. Please evaluate my progress.

    --- MY ORIGINAL PLAN ---
    {json.dumps(data.get('original_plan'), indent=2)}

    --- MY CHECK-INS ---
    {json.dumps(data.get('check_ins'), indent=2)}
    """

    print(f"Generating evaluation...")

    try:
        # --- Call the Gemini API ---
        full_prompt = EVALUATOR_SYSTEM_PROMPT + "\n\n--- USER DATA ---\n\n" + user_prompt
        
        response = model.generate_content(full_prompt)
        
        if not response.parts:
            raise ValueError("Received an empty response from the AI model.")
            
        evaluation_json = json.loads(response.text)

        # Return the parsed JSON object
        return jsonify(evaluation_json)
        
    except json.JSONDecodeError:
        print(f"Error: Failed to decode JSON from AI response: {response.text}")
        return jsonify({"error": "Failed to parse AI response. Please try again."}), 500
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        return jsonify({"error": f"An internal error occurred: {e}"}), 500

# --- Run the App ---
if __name__ == '__main__':
    # Runs the app on localhost:5000
    # Set debug=True for development (provides helpful error messages)
    app.run(debug=True, port=5000)

