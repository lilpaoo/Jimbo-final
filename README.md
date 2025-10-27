# Personal Trainer AI API

A Flask-based API that leverages Google's Gemini AI to generate personalized workout and nutrition plans in structured JSON format. This application acts as an AI-powered personal trainer, providing tailored fitness advice based on user inputs.

## Features

- **Workout Plan Generation**: Create customized workout plans based on user goals, experience level, available days per week, hours per day, and equipment. Returns structured JSON with detailed day-by-day plans.
- **Nutrition Plan Generation**: Generate personalized nutrition plans including calorie targets, macronutrient breakdowns, and sample meal plans. Returns structured JSON with targets and tips.
- **AI-Powered Responses**: Utilizes Google's Gemini 2.5 Flash model configured for JSON output, ensuring consistent and parseable responses.
- **Input Validation**: Ensures all required fields are provided for accurate plan generation.
- **Error Handling**: Comprehensive error handling for API key issues, invalid requests, and JSON parsing errors.

## Prerequisites

- Python 3.7 or higher
- A Google Gemini API key (obtain from [Google AI Studio](https://makersuite.google.com/app/apikey))

## Installation

1. Clone or download this repository to your local machine.

2. Install the required dependencies:
   ```
   pip install -r requirements.txt
   ```

3. Create a `.env` file in the root directory of the project and add your Gemini API key:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```

## Setup

1. Ensure your `.env` file is properly configured with the `GEMINI_API_KEY`.
2. Run the Flask application:
   ```
   python app.py
   ```
3. The API will start on `http://localhost:5000`.

## Usage

The API provides two main endpoints for generating fitness plans. Send POST requests with JSON payloads to the respective endpoints. Responses are returned as structured JSON objects.

### API Endpoints

#### 1. Generate Workout Plan
- **Endpoint**: `POST /generate-workout`
- **Description**: Generates a personalized workout plan in JSON format.
- **Required JSON Fields**:
  - `goal` (string): User's fitness goal (e.g., "Build muscle", "Lose weight", "Improve endurance")
  - `experience_level` (string): User's experience level (e.g., "Beginner", "Intermediate", "Advanced")
  - `days_per_week` (integer): Number of days per week available for workouts
  - `hours_per_day` (number): Hours available per workout day
  - `available_equipment` (string): Equipment available (e.g., "Dumbbells, Barbell, Bodyweight")
- **Optional JSON Fields**:
  - `notes` (string): Any additional notes or preferences

#### 2. Generate Nutrition Plan
- **Endpoint**: `POST /generate-nutrition-plan`
- **Description**: Generates a personalized nutrition plan in JSON format.
- **Required JSON Fields**:
  - `goal` (string): User's nutrition goal (e.g., "Fat Loss", "Muscle Gain", "Maintenance")
  - `weight_kg` (number): Current weight in kilograms
  - `height_cm` (number): Height in centimeters
  - `age` (integer): Age in years
  - `activity_level` (string): Activity level (e.g., "Sedentary", "Lightly Active", "Moderately Active", "Very Active")
- **Optional JSON Fields**:
  - `preferences` (string): Dietary preferences or restrictions

#### 3. Health Check
- **Endpoint**: `GET /`
- **Description**: Simple health check endpoint to verify the API is running.

### Example Requests and Responses

#### Workout Plan Example
**Request:**
```bash
curl -X POST http://localhost:5000/generate-workout \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Build muscle",
    "experience_level": "Intermediate",
    "days_per_week": 4,
    "hours_per_day": 1.5,
    "available_equipment": "Dumbbells, Barbell, Bench",
    "notes": "I have knee issues, so avoid high-impact exercises"
  }'
```

**Response:**
```json
{
  "title": "Workout Plan for Build muscle",
  "frequency": "4",
  "days": [
    {
      "day": "Day 1",
      "focus": "Full Body Strength A",
      "warm_up": "5-10 minutes light cardio and dynamic stretches",
      "exercises": [
        { "name": "Squats", "sets_reps": "3 sets of 8-12 reps" },
        { "name": "Push-ups", "sets_reps": "3 sets of 10-15 reps" },
        { "name": "Dumbbell Rows", "sets_reps": "3 sets of 10-12 reps per side" }
      ],
      "cool_down": "5 minutes static stretching"
    }
  ],
  "motivational_tip": "Stay consistent and track your progress!"
}
```

#### Nutrition Plan Example
**Request:**
```bash
curl -X POST http://localhost:5000/generate-nutrition-plan \
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

**Response:**
```json
{
  "title": "Nutrition Plan for Fat Loss",
  "targets": {
    "calories": "~2100 kcal",
    "protein": "~170g",
    "carbs": "~190g",
    "fats": "~70g"
  },
  "sample_plan": [
    { "meal": "Breakfast", "description": "Oatmeal with berries and nuts" },
    { "meal": "Lunch", "description": "Quinoa salad with vegetables and tofu" },
    { "meal": "Dinner", "description": "Grilled chicken with sweet potatoes and broccoli" },
    { "meal": "Snacks", "description": "Greek yogurt with fruit" }
  ],
  "key_tips": [
    "Drink at least 8 glasses of water daily",
    "Focus on whole, unprocessed foods",
    "Adjust portion sizes based on hunger and results"
  ]
}
```

### Error Responses

- **400 Bad Request**: Missing JSON payload or required fields.
- **500 Internal Server Error**: API key issues, AI response parsing errors, or other internal errors.

## Dependencies

- Flask: Web framework for the API
- google-generativeai: Google's Generative AI library for accessing Gemini models
- python-dotenv: For loading environment variables from .env file

## Contributing

Feel free to submit issues, feature requests, or pull requests to improve this project.

## License

This project is open-source and available under the MIT License.
