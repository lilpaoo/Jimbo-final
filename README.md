# Jimbo - AI Personal Trainer

Jimbo is a comprehensive, AI-powered personal trainer web application. It combines the power of Google's Gemini AI for generating personalized workout/nutrition plans and the TensorFlow MoveNet model for real-time video form analysis.

## Features

- **AI Workout Generator**: Creates customized weekly workout plans based on user goals, experience, and available equipment.
- **AI Nutrition Generator**: Provides high-level nutrition plans with calorie/macro targets and meal examples.
- **AI Form Analysis**: Users can upload a video of an exercise and receive a detailed score (Spine, Stability, Joint, Control) and corrective feedback from an AI coach. Uses TensorFlow MoveNet (Thunder) for high-accuracy pose estimation and Dynamic Time Warping (DTW) to compare user form against a "golden standard" from a database.
- **AI Coach Evaluation**: Analyzes a user's saved plan and check-in logs to provide motivational feedback and recommendations.
- **Dual Login & Save System**:
  - **Google Account Mode**: Securely logs in with a Google account and uses the Google Drive & Sheets API to save/load workout plans and progress logs.
  - **Tester Mode**: Allows for full app functionality without a Google account by saving/loading plan data and check-ins to a local .xlsx (Excel) file.
- **Progress Logger**: Log check-ins with date, weight, and notes.
- **Responsive Web Interface**: Built with HTML5, CSS3, and JavaScript for a modern, user-friendly experience.

## Tech Stack

### Backend
- **Python**: Core language.
- **Flask**: Web server and API framework.
- **Google Gemini API**: For all text/JSON-based AI generation (workout plans, nutrition, evaluations, form feedback).
- **TensorFlow & TensorFlow-Hub**: For running the MoveNet model.
- **OpenCV**: For video processing.
- **DTW-Python**: For time-series form comparison.
- **SQLite**: For storing "golden standard" exercise data in `correct_movement.db`.
- **python-dotenv**: For environment variable management.
- **Flask-CORS**: For handling cross-origin requests.

### Frontend
- **HTML5**: Structure.
- **CSS3**: Custom-styled, responsive layout.
- **JavaScript (ES6+)**: Client-side logic.
- **Google Identity Services**: For OAuth 2.0 login.
- **SheetJS**: For client-side Excel file creation/parsing in Tester Mode.

## Prerequisites

- Python 3.7 or higher
- A Google Gemini API key (obtain from [Google AI Studio](https://makersuite.google.com/app/apikey))
- A Google OAuth Client ID (obtain from [Google Cloud Console](https://console.cloud.google.com/))
- The `correct_movement.db` SQLite database file (contains golden standard exercise data; not included in the repository)

## Setup & Installation

Follow these steps to get the application running locally.

### 1. Backend Setup

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
   Install all required Python packages using the provided `requirements.txt` file.
   ```
   pip install -r requirements.txt
   ```

4. **Create .env File**:
   Create a file named `.env` in the root of the project and add your API keys. You must get your `GOOGLE_CLIENT_ID` from the Google Cloud Console (for OAuth) and a `GOOGLE_API_KEY` from Google AI Studio (for Gemini).
   ```
   GOOGLE_API_KEY="your_gemini_api_key_here"
   GOOGLE_CLIENT_ID="your_google_oauth_client_id_here.apps.googleusercontent.com"
   ```
   Note: In `app.py`, the code will also check for `GEMINI_API_KEY` as a fallback for the Gemini API.

5. **Set Up the Database**:
   The form analysis feature requires a SQLite database named `correct_movement.db` containing the "golden standard" exercise data. This file is not included in the repository. You must have this database file in the same directory as `app.py` for the `/exercises` and `/analyze-form` endpoints to work.

### 2. Frontend Setup

1. **Configure Google Client ID**:
   Go to the Google Cloud Console. Find your OAuth 2.0 Client ID (the same one you put in `.env`).
   - Under **Authorized JavaScript origins**, add `http://127.0.0.1:5000`.
   - Under **Authorized redirect URIs**, add `http://127.0.0.1:5000`.

2. **No Other Setup Needed!**
   All frontend dependencies (SheetJS) are loaded via a CDN in `index.html`.

## Running the Application

1. **Start the Backend Server**:
   Run the `app.py` file from your terminal (make sure your virtual environment is activated).
   ```
   python app.py
   ```
   You should see output indicating the Flask server is running on `http://127.0.0.1:5000/`.

2. **Open the Frontend**:
   Open your web browser and navigate to:
   ```
   http://127.0.0.1:5000/
   ```
   The `app.py` server is configured to serve the `index.html` file automatically from the root URL.

## Usage

### Frontend Interface

- **Login**: Choose between Google Account login or Tester Mode.
- **Workout Generator**: Fill in details (goal, experience, days/week, hours/day, equipment) and generate a plan. Save to Google Drive or download as Excel.
- **Nutrition Generator**: Input personal details and generate a nutrition plan.
- **Progress Logger**: Log check-ins with date, weight, and notes. View recent check-ins.
- **Form Analysis**: Select an exercise, upload a video, and get AI feedback on your form.
- **Coach Evaluation**: Get AI evaluation based on your plan and check-ins.

### API Endpoints

The backend provides several RESTful endpoints. The frontend interacts with these, but you can also call them directly.

#### 1. Generate Workout Plan
- **Endpoint**: `POST /generate-workout`
- **Description**: Generates a personalized workout plan.
- **Payload**:
  ```json
  {
    "goal": "Muscle Gain",
    "experience_level": "Intermediate",
    "days_per_week": 4,
    "hours_per_day": 1,
    "available_equipment": "Full gym",
    "notes": "Optional notes"
  }
  ```
- **Response**: JSON object with plan details.

#### 2. Generate Nutrition Plan
- **Endpoint**: `POST /generate-nutrition-plan`
- **Description**: Generates a personalized nutrition plan.
- **Payload**:
  ```json
  {
    "goal": "Fat Loss",
    "weight_kg": 75,
    "height_cm": 175,
    "age": 30,
    "activity_level": "Moderately Active",
    "preferences": "Vegetarian"
  }
  ```
- **Response**: JSON object with targets, sample plan, and tips.

#### 3. Evaluate Plan
- **Endpoint**: `POST /evaluate-plan`
- **Description**: Provides AI evaluation based on plan and check-ins.
- **Payload**:
  ```json
  {
    "original_plan": { ... },
    "check_ins": [ ... ]
  }
  ```
- **Response**: JSON object with analysis, observations, and recommendations.

#### 4. List Exercises
- **Endpoint**: `GET /exercises`
- **Description**: Retrieves list of available exercises for form analysis.
- **Response**: JSON array of exercise names.

#### 5. Analyze Form
- **Endpoint**: `POST /analyze-form`
- **Description**: Analyzes uploaded video for form feedback.
- **Payload**: FormData with `exercise_name` and `video` file.
- **Response**: Streaming JSON updates, final response with scores and analysis.

#### 6. Config
- **Endpoint**: `GET /config`
- **Description**: Returns Google Client ID for frontend.
- **Response**: JSON with `google_client_id`.

#### 7. Static Files
- **Endpoint**: `GET /<path>`
- **Description**: Serves static files (e.g., `index.html`, images).

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

## Contributing

Feel free to submit issues, feature requests, or pull requests to improve this project.

## License

This project is open-source and available under the MIT License.
