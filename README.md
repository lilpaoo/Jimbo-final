# Jimbo - AI Personal Trainer

Jimbo is a comprehensive, AI-powered personal trainer web application that combines Google's Gemini AI for personalized workout and nutrition plans with TensorFlow's MoveNet model for real-time video form analysis.

## Features

- **AI Workout Generator**: Creates customized weekly workout plans based on user goals, experience level, available equipment, and time constraints.
- **AI Nutrition Generator**: Provides high-level nutrition plans with calorie/macro targets and meal examples tailored to user preferences.
- **AI Form Analysis**: Upload a video of an exercise to receive a detailed score (Spine, Stability, Joint, Control) and corrective feedback from an AI coach using TensorFlow MoveNet and Dynamic Time Warping (DTW).
- **AI Coach Evaluation**: Analyzes saved plans and progress logs to offer motivational feedback and recommendations.
- **Dual Login & Save System**:
  - **Google Account Mode**: Secure login via Google OAuth, saving plans and logs to Google Drive & Sheets.
  - **Tester Mode**: Full functionality without a Google account, saving data locally as Excel files.
- **Progress Logger**: Log check-ins with date, weight, and notes; view recent progress.
- **Responsive Web Interface**: Modern, user-friendly design built with HTML5, CSS3, and JavaScript.

## Tech Stack

### Backend
- **Python**: Core language.
- **Flask**: Web server and API framework.
- **Google Gemini API**: Handles all AI text/JSON generation (plans, nutrition, evaluations, form feedback).
- **TensorFlow & TensorFlow-Hub**: Runs the MoveNet model for pose estimation.
- **OpenCV**: Video processing.
- **DTW-Python**: Time-series form comparison.
- **SQLite**: Stores golden standard exercise data in `correct_movement.db`.
- **python-dotenv**: Environment variable management.
- **Flask-CORS**: Cross-origin request handling.

### Frontend
- **HTML5**: Structure.
- **CSS3**: Responsive styling.
- **JavaScript (ES6+)**: Client-side logic.
- **Google Identity Services**: OAuth 2.0 login.
- **SheetJS**: Client-side Excel file parsing/creation in Tester Mode.

## Prerequisites

- Python 3.7 or higher.
- Google Gemini API key (from [Google AI Studio](https://makersuite.google.com/app/apikey)).
- Google OAuth Client ID (from [Google Cloud Console](https://console.cloud.google.com/)).
- SQLite database file `correct_movement.db` (contains golden standard exercise data; not included in the repository).

## Setup & Installation

1. **Clone the Repository**:
   ```
   git clone [your-repo-url]
   cd [your-repo-folder]
   ```

2. **Create a Virtual Environment**:
   ```
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install Dependencies**:
   Install required packages from `requirements.txt`:
   ```
   pip install -r requirements.txt
   ```

4. **Configure Environment Variables**:
   Create a `.env` file in the root directory with your API keys:
   ```
   GOOGLE_API_KEY="your_gemini_api_key_here"
   GOOGLE_CLIENT_ID="your_google_oauth_client_id_here.apps.googleusercontent.com"
   ```
   Note: `GEMINI_API_KEY` is also accepted as a fallback for the Gemini API.

5. **Set Up the Database**:
   Ensure `correct_movement.db` is in the same directory as `app.py`. This file is required for form analysis endpoints (`/exercises` and `/analyze-form`).

6. **Configure Google OAuth**:
   In the Google Cloud Console, under your OAuth 2.0 Client ID:
   - Add `http://127.0.0.1:5000` to **Authorized JavaScript origins**.
   - Add `http://127.0.0.1:5000` to **Authorized redirect URIs**.

## Running the Application

1. **Start the Backend Server**:
   With the virtual environment activated, run:
   ```
   python app.py
   ```
   The server will start on `http://127.0.0.1:5000/`.

2. **Access the Frontend**:
   Open a web browser and navigate to `http://127.0.0.1:5000/`. The server serves `index.html` automatically.

## Frontend Usage

- **Login**: Choose Google Account login for cloud saving or Tester Mode for local Excel saving.
- **Workout Generator**: Input goal, experience, days/week, hours/day, equipment, and optional notes to generate a plan. Save to Google Drive or download as Excel.
- **Nutrition Generator**: Provide personal details (goal, weight, height, age, activity level, preferences) to generate a nutrition plan.
- **Progress Logger**: Log check-ins with date, weight, and notes. View recent entries.
- **Form Analysis**: Select an exercise, upload a video, and receive AI-scored feedback.
- **Coach Evaluation**: Get AI evaluation based on your saved plan and check-in logs.

## API Usage

The backend provides RESTful endpoints for direct API interaction. All requests/responses are in JSON format. The server runs on `http://127.0.0.1:5000` by default.

### 1. Generate Workout Plan
- **Endpoint**: `POST /generate-workout`
- **Description**: Generates a personalized workout plan.
- **Request**:
  ```bash
  curl -X POST http://127.0.0.1:5000/generate-workout \
    -H "Content-Type: application/json" \
    -d '{
      "goal": "Muscle Gain",
      "experience_level": "Intermediate",
      "days_per_week": 4,
      "hours_per_day": 1,
      "available_equipment": "Full gym",
      "notes": "Optional notes"
    }'
  ```
- **Response** (Success):
  ```json
  {
    "title": "Your Muscle Gain Workout Plan",
    "frequency": "4 Training Days",
    "days": [
      {
        "day": "Day 1",
        "focus": "Push Day (Chest, Shoulders, Triceps)",
        "warm_up": "5-10 min light cardio",
        "exercises": [
          {"name": "Bench Press", "sets_reps": "4 sets x 8-10 reps"},
          {"name": "Overhead Press", "sets_reps": "3 sets x 8-10 reps"}
        ],
        "cool_down": "Static stretches"
      }
    ],
    "motivational_tip": "Consistency is key!"
  }
  ```

### 2. Generate Nutrition Plan
- **Endpoint**: `POST /generate-nutrition-plan`
- **Description**: Generates a personalized nutrition plan.
- **Request**:
  ```bash
  curl -X POST http://127.0.0.1:5000/generate-nutrition-plan \
    -H "Content-Type: application/json" \
    -d '{
      "goal": "Fat Loss",
      "weight_kg": 75,
      "height_cm": 175,
      "age": 30,
      "activity_level": "Moderately Active",
      "preferences": "Vegetarian"
    }'
  ```
- **Response** (Success):
  ```json
  {
    "title": "Your Fat Loss Nutrition Plan",
    "targets": {
      "calories": "2200",
      "protein": "150g",
      "carbs": "200g",
      "fats": "70g"
    },
    "sample_plan": [
      {"meal": "Breakfast", "description": "Oatmeal with fruits and nuts"},
      {"meal": "Lunch", "description": "Quinoa salad with veggies"},
      {"meal": "Dinner", "description": "Grilled tofu with vegetables"},
      {"meal": "Snack", "description": "Greek yogurt with berries"}
    ],
    "key_tips": [
      "Prioritize protein at each meal",
      "Drink 2-3L of water daily",
      "Limit processed foods"
    ]
  }
  ```

### 3. Evaluate Plan
- **Endpoint**: `POST /evaluate-plan`
- **Description**: Provides AI evaluation based on plan and check-ins.
- **Request**:
  ```bash
  curl -X POST http://127.0.0.1:5000/evaluate-plan \
    -H "Content-Type: application/json" \
    -d '{
      "original_plan": {"title": "Workout Plan", ...},
      "check_ins": [
        {"date": "2023-10-01", "weight_kg": 75, "notes": "Good session"},
        {"date": "2023-10-02", "weight_kg": 74.5, "notes": "Felt strong"}
      ]
    }'
  ```
- **Response** (Success):
  ```json
  {
    "title": "Your Progress Evaluation",
    "analysis": "You've been consistent with your workouts and are seeing progress in weight loss.",
    "key_observations": [
      "Great job logging sessions regularly!",
      "Weight is trending down, aligning with your fat loss goal."
    ],
    "recommendations": [
      "Keep up the consistency.",
      "Increase weight on main lifts if strength stalls."
    ]
  }
  ```

### 4. Chat with Plan
- **Endpoint**: `POST /chat-with-plan`
- **Description**: Chat about your plan with the AI coach.
- **Request**:
  ```bash
  curl -X POST http://127.0.0.1:5000/chat-with-plan \
    -H "Content-Type: application/json" \
    -d '{
      "context_plan": {"title": "Workout Plan", ...},
      "message": "How can I modify this for knee issues?",
      "history": []
    }'
  ```
- **Response** (Success):
  ```json
  {
    "response": "For knee issues, focus on low-impact exercises like leg presses..."
  }
  ```

### 5. List Exercises
- **Endpoint**: `GET /exercises`
- **Description**: Retrieves available exercises for form analysis.
- **Request**:
  ```bash
  curl http://127.0.0.1:5000/exercises
  ```
- **Response** (Success):
  ```json
  ["Squat", "Bench Press", "Deadlift"]
  ```

### 6. Analyze Form
- **Endpoint**: `POST /analyze-form`
- **Description**: Analyzes uploaded video for form feedback (streaming response).
- **Request** (using curl with file upload):
  ```bash
  curl -X POST http://127.0.0.1:5000/analyze-form \
    -F "exercise_name=Squat" \
    -F "video=@path/to/video.mp4"
  ```
- **Response**: Streaming JSON updates, final response includes scores and analysis.

### 7. Config
- **Endpoint**: `GET /config`
- **Description**: Returns Google Client ID for frontend.
- **Request**:
  ```bash
  curl http://127.0.0.1:5000/config
  ```
- **Response** (Success):
  ```json
  {
    "google_client_id": "your_client_id.apps.googleusercontent.com"
  }
  ```

## Dependencies

See `requirements.txt` for the full list. Key packages include:
- flask
- flask-cors
- google-generativeai
- python-dotenv
- opencv-python-headless
- numpy
- tensorflow
- tensorflow-hub
- dtw-python

## 🐳 Run with Docker

You can run this application using Docker without installing Python or any external libraries. This image comes pre-packaged with the `correct_movement.db` database file.

### Requirements

* **Docker:** You must have Docker installed (e.g., Docker Desktop).
* **API Keys:** You need your own `GOOGLE_API_KEY` and `GOOGLE_CLIENT_ID` (please refer to the [Prerequisites](#prerequisites) section).

---

### How to Run the Container

Open your terminal (PowerShell, CMD, Terminal, etc.) and execute the following command.

> **Note:** Be sure to replace `YOUR_API_KEY_HERE` and `YOUR_CLIENT_ID_HERE` with your actual values.

```bash
docker run -d -p 5000:5000  -e GOOGLE_API_KEY="YOUR_API_KEY_HERE"  -e GOOGLE_CLIENT_ID="YOUR_CLIENT_ID_HERE"  --name jimbo_app  trungdt226/jimbo-final-web:latest

## Contributing

Contributions are welcome! Submit issues, feature requests, or pull requests to improve Jimbo.

## License

This project is open-source under the MIT License.
