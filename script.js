// --- JWT Decode (Simple) ---
function decodeJwtResponse(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) { console.error("Failed to decode JWT:", e); return null; }
}

// --- Helper to wait for GAPI to fully load ---
async function waitForGapi() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.gapi && gapi.client) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

// --- GOOGLE API & AUTH (GLOBAL SCOPE) ---

// Global variable to catch early logins
window.pendingGoogleLogin = null;

// This loads the GAPI client (for Sheets/Drive)
// Must be global for 'onload' to find it
window.gapiLoaded = () => {
      gapi.load('client', async () => {
        await gapi.client.init({
          discoveryDocs: [
            'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
            'https://sheets.googleapis.com/$discovery/rest?version=v4'
          ],
        });
        console.log("✅ GAPI client ready");
        window.gapiReady = true;
      });
    };

// Google Sign-In Callback
// Must be global for GSI library to find it
window.onSignIn = (googleUser) => {
    try {
        const userData = decodeJwtResponse(googleUser.credential);
        if (!userData.email) throw new Error("No email found.");
        
        // Store it, in case the listener isn't ready
        window.pendingGoogleLogin = userData;
        
        // Try to dispatch the event, in case the listener *is* ready
        document.dispatchEvent(new CustomEvent('google-signin-success', { detail: userData }));

    } catch (error) {
        console.error("Error in onSignIn:", error);
        const authError = document.getElementById('auth-error');
        if (authError) authError.textContent = "Error decoding login data.";
    }
}


document.addEventListener('DOMContentLoaded', () => {

    // --- CONSTANTS & CONFIG ---
    const API_URL = "http://127.0.0.1:5000"; // Your Python API
    const SPREADSHEET_FILE_NAME = "AI_Trainer_Data";
    const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
    
    // --- STATE ---
    let CLIENT_ID = null; // Will be fetched from backend
    let isAppInitialized = false; // Flag to prevent race conditions
    let loginMode = null; // 'google' or 'tester'
    let currentPlan = null;     // Holds the last generated plan
    let allCheckIns = [];       // Holds check-ins read from Sheet
    let currentNutritionPlan = null; // Holds the last generated nutrition plan
    let workoutChatHistory = [];
    let nutritionChatHistory = [];
    let currentUserEmail = null;
    let tokenClient = null;     // Google's token client
    let spreadsheetId = null;   // The ID of the user's data file
    let hasBeenAuthorized = false;

    // --- UI ELEMENTS ---
    const authContainer = document.getElementById('auth-container');
    const mainAppContainer = document.getElementById('main-app-container');
    const authError = document.getElementById('auth-error');
    const signOutBtn = document.getElementById('sign-out-btn');
    const userEmail = document.getElementById('user-email');
    const userEmailSidebar = document.getElementById('user-email-sidebar');
    const pageSubtitle = document.getElementById('page-subtitle');
    const testerLoginBtn = document.getElementById('tester-login-btn');
    const googleSignInBtn = document.getElementById('google-sign-in-button-placeholder');
    
    // Workout Tab
    const workoutForm = document.getElementById('workout-form');
    const apiResponseEl = document.getElementById('api-response');
    const saveBtn = document.getElementById('save-btn');
    const saveStatus = document.getElementById('save-status');
    const workoutGenBtn = document.getElementById('workout-generate-btn');
    const workoutChatWidget = document.getElementById('workout-chat-widget');
    const workoutChatHistoryEl = document.getElementById('workout-chat-history');
    const workoutChatInput = document.getElementById('workout-chat-input');
    const workoutChatSend = document.getElementById('workout-chat-send');

    // Nutrition Tab
    const nutritionForm = document.getElementById('nutrition-form');
    const nutritionResponseEl = document.getElementById('nutrition-response');
    const nutritionGenBtn = document.getElementById('nutrition-generate-btn');
    const saveNutritionBtn = document.getElementById('save-nutrition-btn');
    const saveNutritionStatus = document.getElementById('save-nutrition-status');
    const nutritionChatWidget = document.getElementById('nutrition-chat-widget');
    const nutritionChatHistoryEl = document.getElementById('nutrition-chat-history');
    const nutritionChatInput = document.getElementById('nutrition-chat-input');
    const nutritionChatSend = document.getElementById('nutrition-chat-send');

    // Progress Tab
    const checkinForm = document.getElementById('checkin-form');
    const checkinListEl = document.getElementById('checkin-list');
    const testerUploadSection = document.getElementById('tester-upload-section');
    const uploadDataFile = document.getElementById('upload-data-file');
    const uploadFileName = document.getElementById('upload-file-name');
    const uploadStatus = document.getElementById('upload-status');


    // Form Analysis Tab
    const formAnalysisForm = document.getElementById('form-analysis-form');
    const exerciseSelect = document.getElementById('exercise-select');
    const videoUpload = document.getElementById('video-upload-real');
    const fileNameDisplay = document.getElementById('file-name-display');
    const formAnalysisResponseEl = document.getElementById('form-analysis-response');
    const analyzeFormBtn = document.getElementById('analyze-form-btn');
    // --- NEW PROGRESS UI ELEMENTS ---
    const progressContainer = document.getElementById('analysis-progress-container');
    const progressBar = document.getElementById('analysis-progress-bar');
    const progressStatus = document.getElementById('analysis-progress-status');

    
    // Coach Tab
    const evalResponseEl = document.getElementById('eval-response');
    const evaluateBtn = document.getElementById('evaluate-btn');

    // --- API HELPER (to Python Backend) ---
    async function apiFetch(endpoint, options = {}) {
        // Check for file uploads
        const isFormData = options.body instanceof FormData;

        // Setup default headers if not a file upload
        if (!isFormData) {
            options.headers = {
                'Content-Type': 'application/json',
                ...options.headers,
            };
        }
        // If it is FormData, DO NOT set Content-Type. The browser will do it.
        
        try {
            const response = await fetch(`${API_URL}${endpoint}`, options);
            const data = await response.json(); // Always expect JSON back
            
            if (!response.ok) {
                throw new Error(data.error || `HTTP error! status: ${response.status}`);
            }
            return data;
        } catch (err) {
            console.error(`Error fetching ${endpoint}:`, err);
            if (err.message.includes("Failed to fetch")) {
                throw new Error("Cannot connect to API server. Is it running?");
            }
            throw err;
        }
    }
    
    // --- GOOGLE API & AUTH (INITIALIZATION) ---
    
    /**
 * --- (Streamlined) Helper to get an Access Token when we need one ---
 * This function is now the single point of truth for getting a token.
 * It automatically sets the token for GAPI, removing redundancy.
 */
function getAccessToken(callback) {
  if (!tokenClient || !isAppInitialized) {
    console.error("Token client not initialized.");
    authError.textContent = "Auth client not ready. Please refresh.";
    // Re-enable buttons on error
    if (saveBtn) saveBtn.disabled = false;
    if (checkinForm) checkinForm.querySelector('button[type="submit"]').disabled = false;
    return;
  }

  // --- UPDATE: Handle Callback ---
  tokenClient.callback = async (tokenResponse) => {
    if (tokenResponse && tokenResponse.access_token) {
      console.log("✅ Got access token. Setting for GAPI.");
      await waitForGapi(); // ensure gapi is ready before use

      // Automatically set token for all future gapi calls
      gapi.client.setToken({ access_token: tokenResponse.access_token });

      // MARK THAT WE HAVE BEEN AUTHORIZED
      hasBeenAuthorized = true; 

      // Run the original callback (e.g., handleLoginAndAuthorization or _doSavePlanToGoogle)
      callback();

    } else if (tokenResponse.error) {
       console.error("Token Error:", tokenResponse.error, tokenResponse.error_description);
       alert(`Error getting permission: ${tokenResponse.error_description || tokenResponse.error}. Check popup blocker?`);
       // Re-enable buttons if auth fails
       if (saveBtn) saveBtn.disabled = false;
       if (checkinForm) checkinForm.querySelector('button[type="submit"]').disabled = false;
       const googleLoginButton = document.getElementById('google-login-btn');
       if (googleLoginButton) {
            googleLoginButton.disabled = false;
            googleLoginButton.textContent = "Sign in with Google";
       }
    } else {
      console.error("❌ No access token returned:", tokenResponse);
      alert("Failed to get Google access token. Try signing in again.");
    }
  };

  // --- UPDATED LOGIC ---
  // Instead of hasGrantedAllScopes, we use our own state variable.
  if (hasBeenAuthorized) {
      // We were previously authorized, just get token silently.
      console.log("Already authorized, requesting token silently.");
      tokenClient.requestAccessToken({prompt: 'select_account'});
  } else {
      // This is the first time, or a previous attempt failed.
      // Request consent explicitly.
      console.log("Requesting user consent (first time or re-auth).");
      tokenClient.requestAccessToken({prompt: 'consent', scope: GOOGLE_SCOPES});
  }
}
    
    // --- NEW: Tester Mode Login ---
    function loginAsTester() {
        console.log("Logging in as Tester.");
        loginMode = 'tester';
        currentUserEmail = 'tester@jimbo.ai'; // Set a placeholder email
        showAppUI(currentUserEmail);
    }

    // Sign Out
    function signOutUser() {
        currentUserEmail = null;
        currentPlan = null;
        currentNutritionPlan = null;
        workoutChatHistory = [];
        nutritionChatHistory = [];
        allCheckIns = [];
        spreadsheetId = null;
        isAppInitialized = false; // Reset the app state
        loginMode = null; // <-- NEW: Reset login mode
        if (window.google) google.accounts.id.disableAutoSelect();
        showAuthUI();
        
        // Hide chat widgets
        workoutChatWidget.classList.add('hidden');
        nutritionChatWidget.classList.add('hidden');
        // Clear chat history
        workoutChatHistoryEl.innerHTML = "";
        nutritionChatHistoryEl.innerHTML = "";
        
        // Re-initialize the app in case they want to log in again
        initializeApp();
    }

    // --- UI TOGGLING ---
    // (New Version)
function showAppUI(email) {
    userEmail.textContent = email;
    userEmailSidebar.textContent = email.split('@')[0]; // Show username
    mainAppContainer.classList.remove('hidden');
    authContainer.style.display = 'none'; // Use style.display to match auth logic
    authError.textContent = "";
    
    if (loginMode === 'google') {
        pageSubtitle.textContent = "Your data is saved securely to your Google Drive.";
        saveBtn.textContent = "Save Plan to Google Drive";
        testerUploadSection.classList.add('hidden');
        
        // Token has been retrieved, JUST LOAD DATA
        console.log("App shown. Loading user data from Drive.");
        loadUserDataFromDrive();
        
    } else if (loginMode === 'tester') {
        pageSubtitle.textContent = "You are in Tester Mode. Data is saved locally.";
        saveBtn.textContent = "Download Data File (.xlsx)";
        testerUploadSection.classList.remove('hidden');
        // No Google API calls, just clear the UI
        apiResponseEl.innerHTML = `<p>Generate a plan. You can save/load it as an Excel file.</p>`;
        renderCheckins([]);
    }
    
    // Load exercises (common to both modes)
    loadExercises();
}

    function showAuthUI() {
        mainAppContainer.classList.add('hidden');
        authContainer.style.display = 'flex'; // Use style.display
        // Clear all fields
        apiResponseEl.innerHTML = `<p>Your generated plan will appear here...</p>`;
        nutritionResponseEl.innerHTML = `<p>Your generated nutrition plan will appear here...</p>`;
        checkinListEl.innerHTML = `<li class="checkin-item">No check-ins yet.</li>`;
        evalResponseEl.innerHTML = `<p>Evaluation will appear here...</p>`;
        formAnalysisResponseEl.innerHTML = `<p>Please select an exercise and upload a video to get your form analysis.</p>`;
        progressContainer.classList.add('hidden'); // Hide progress bar on logout
        saveBtn.disabled = true;
        saveNutritionBtn.disabled = true;
    }

    // --- HTML FORMATTING HELPERS (Unchanged) ---
    function formatWorkoutPlanAsHTML(plan) {
        let html = `<h3>${plan.title}</h3>`;
        html += `<p><strong>Frequency:</strong> ${plan.frequency}</p>`;
        plan.days.forEach(day => {
            html += `<div style="margin: 1.5rem 0; padding: 1rem; background: rgba(255,255,255,0.05); border-radius: 12px;">`;
            html += `<h4 style="margin-bottom: 0.5rem; color: #e5b8ff;">${day.day} - ${day.focus}</h4>`;
            html += `<p><em>Warm-up:</em> ${day.warm_up}</p>`;
            html += `<ul style="margin: 0.5rem 0;">`;
            day.exercises.forEach(ex => {
            html += `<li><strong>${ex.name}</strong>: ${ex.sets_reps}</li>`;
            });
            html += `</ul>`;
            html += `<p><em>Cool-down:</em> ${day.cool_down}</p>`;
            html += `</div>`;
        });
        html += `<p style="margin-top: 1rem; font-style: italic; color: #c689ff;">${plan.motivational_tip}</p>`;
        return html;
    }

    function formatNutritionPlanAsHTML(plan) {
        let html = `<h3>${plan.title}</h3>`;
        html += `<div style="background: rgba(255,255,255,0.05); padding: 1rem; border-radius: 12px; margin: 1rem 0;">`;
        html += `<p><strong>Daily Targets:</strong></p>`;
        html += `<ul>`;
        html += `<li>Calories: <strong>${plan.targets.calories}</strong></li>`;
        html += `<li>Protein: <strong>${plan.targets.protein}</strong></li>`;
        html += `<li>Carbs: <strong>${plan.targets.carbs}</strong></li>`;
        html += `<li>Fats: <strong>${plan.targets.fats}</strong></li>`;
        html += `</ul></div>`;
        html += `<h4 style="margin-top: 1rem;">Sample Meals:</h4>`;
        plan.sample_plan.forEach(meal => {
            html += `<p><strong>${meal.meal}:</strong> ${meal.description}</p>`;
        });
        html += `<h4 style="margin-top: 1rem;">Key Tips:</h4><ul>`;
        plan.key_tips.forEach(tip => {
            html += `<li>${tip}</li>`;
        });
        html += `</ul>`;
        return html;
    }
    
    function formatEvaluationAsHTML(evaluation) {
        let html = `<h3>${evaluation.title}</h3>`;
        html += `<p style="text-align: left; margin: 1rem 0;"><strong>Analysis:</strong> ${evaluation.analysis}</p>`;
        html += `<h4 style="text-align: left; color: #e5b8ff;">Key Observations:</h4><ul style="text-align: left;">`;
        evaluation.key_observations.forEach(obs => {
            html += `<li>${obs}</li>`;
        });
        html += `</ul>`;
        html += `<h4 style="text-align: left; color: #e5b8ff; margin-top: 1rem;">Recommendations:</h4><ul style="text-align: left;">`;
        evaluation.recommendations.forEach(rec => {
            html += `<li>${rec}</li>`;
        });
        html += `</ul>`;
        return html;
    }
    
    function formatFormAnalysisAsHTML(data) {
        const scores = data.scores;
        const analysis = data.analysis_markdown;
        
        let html = `
            <h3 style="color: white; font-size: 1.5rem; text-align: center; margin-bottom: 1.5rem;">
                Final Score: ${scores['Final Score']} / 100
            </h3>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="background: var(--input-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--input-border);">
                    <strong>Spine Score:</strong> ${scores['Spine Score']}/100
                </div>
                <div style="background: var(--input-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--input-border);">
                    <strong>Stability Score:</strong> ${scores['Stability Score']}/100
                </div>
                <div style="background: var(--input-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--input-border);">
                    <strong>Joint Score:</strong> ${scores['Joint Score']}/100
                </div>
                 <div style="background: var(--input-bg); padding: 1rem; border-radius: 12px; border: 1px solid var(--input-border);">
                    <strong>Control Score:</strong> ${scores['Control Score']}/100
                </div>
            </div>
        `;
        
        // Convert simple markdown from AI to HTML
        let analysisHtml = analysis
            .replace(/### (.*)/g, '<h3>$1</h3>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\* (.*)/g, '<li>$1</li>')
            .replace(/(\r\n|\n|\r)/gm, '<br>'); // Handle newlines
            
        // Fix for list items not being in a list
        analysisHtml = analysisHtml.replace(/<br><li>/g, '<li>');
        analysisHtml = analysisHtml.replace(/(<li>.*?<\/li>)/g, '<ul>$1</ul>');
        // This cleans up multiple </ul><ul> between list items
        analysisHtml = analysisHtml.replace(/<\/ul><br><ul>/g, '');
        analysisHtml = analysisHtml.replace(/<\/ul><ul>/g, '');


        html += analysisHtml;
        
        return html;
    }


    function renderCheckins(checkins = []) {
        checkinListEl.innerHTML = '';
        if (checkins.length === 0) {
            checkinListEl.innerHTML = '<li class="checkin-item">No check-ins yet.</li>';
            return;
        }
        checkins.forEach(checkin => {
            const li = document.createElement('li');
            li.classList.add('checkin-item');
            li.innerHTML = `
                <p><strong>Date:</strong> ${checkin.date}</p>
                <p><strong>Weight:</strong> ${checkin.weight_kg || 'N/A'} kg</p>
                <p><strong>Notes:</strong> ${checkin.notes || '—'}</p>
            `;
            checkinListEl.appendChild(li);
        });
    }

    /**
         * Convert workout plan JSON object to a 2D array
         * for nice display in a spreadsheet.
         */
        function getFriendlyPlanData(plan) {
            const data = [];
            
            if (!plan) return data; 

            // Add summary info
            data.push(["Title", plan.title || ""]);
            data.push(["Frequency", plan.frequency || ""]);
            data.push(["", ""]); // Empty row for spacing

            // Add table headers
            data.push(["Day", "Focus", "Type", "Details"]);

            // Add exercises
            if (plan.days && Array.isArray(plan.days)) {
                plan.days.forEach(day => {
                    let dayAdded = false; // Only add day name and focus on the first row
                    
                    if (day.warm_up) {
                        data.push([day.day, day.focus, "Warm-up", day.warm_up]);
                        dayAdded = true;
                    }
                    if (day.exercises && Array.isArray(day.exercises)) {
                        day.exercises.forEach(ex => {
                            // If day/focus hasn't been added, add it to the first row
                            data.push([
                                dayAdded ? "" : day.day, 
                                dayAdded ? "" : day.focus, 
                                "Exercise", 
                                `${ex.name}: ${ex.sets_reps}`
                            ]);
                            dayAdded = true;
                        });
                    }
                    if (day.cool_down) {
                        data.push([
                            dayAdded ? "" : day.day, 
                            dayAdded ? "" : day.focus, 
                            "Cool-down", 
                            day.cool_down
                        ]);
                    }
                    
                    data.push(["", "", "", ""]); // Empty row between days
                });
            }
            
            // Add motivational tip
            data.push(["", "", "", ""]); // Empty row
            data.push(["Motivational Tip", "", "", plan.motivational_tip || ""]);

            return data;
        }

        function getFriendlyNutritionData(plan) {
            const data = [];
            if (!plan) return data;

            data.push(["Title", plan.title]);
            data.push(["", ""]); // Empty row
            data.push(["Target", "Value"]);
            data.push(["Calories", plan.targets.calories]);
            data.push(["Protein", plan.targets.protein]);
            data.push(["Carbs", plan.targets.carbs]);
            data.push(["Fats", plan.targets.fats]);
            data.push(["", ""]); // Empty row
            data.push(["Meal", "Example"]);
            plan.sample_plan.forEach(meal => {
                data.push([meal.meal, meal.description]);
            });
            data.push(["", ""]); // Empty row
            data.push(["Key Tips"]);
            plan.key_tips.forEach(tip => {
                data.push([tip]);
            });
            return data;
        }


    // --- CORE APP LOGIC (API Calls) ---

    async function handleLoginAndAuthorization() {
    // This function is called AFTER getAccessToken succeeds
    // and gapi.client.setToken has been called
    try {
        // 1. Call 'userinfo' API to get email
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                'Authorization': `Bearer ${gapi.client.getToken().access_token}`
            }
        });
        
        if (!userInfoResponse.ok) {
            throw new Error("Could not fetch user info.");
        }

        const userData = await userInfoResponse.json();
        
        if (!userData.email) {
            throw new Error("No email found in user info.");
        }

        // 2. Set application state
        loginMode = 'google';
        currentUserEmail = userData.email;

        // 3. Show the application UI
        showAppUI(currentUserEmail);

    } catch (error) {
        console.error("Error in handleLoginAndAuthorization:", error);
        authError.textContent = `Error getting user info: ${error.message}`;
        // Re-enable button on error
        const googleLoginButton = document.getElementById('google-login-btn');
        if (googleLoginButton) {
            googleLoginButton.disabled = false;
            googleLoginButton.textContent = "Sign in with Google";
        }
    }
}


    async function generateWorkout() {
        if (!currentUserEmail) {
            apiResponseEl.innerHTML = `<p style="color: var(--error);">You must be logged in to generate a plan.</p>`;
            return;
        }
        
        workoutGenBtn.disabled = true;
        workoutGenBtn.textContent = "Generating...";
        apiResponseEl.innerHTML = `<p>Generating your plan...</p>`;
        saveBtn.disabled = true;
        saveStatus.textContent = '';
        
        const formData = {
            goal: document.getElementById('goal').value,
            experience_level: document.getElementById('experience_level').value,
            days_per_week: parseInt(document.getElementById('days_per_week').value),
            hours_per_day: parseFloat(document.getElementById('hours_per_day').value),
            available_equipment: document.getElementById('available_equipment').value,
            notes: ""
        };

        try {
            const plan = await apiFetch('/generate-workout', {
                method: 'POST', body: JSON.stringify(formData)
            });
            currentPlan = plan; // Store in local state
            apiResponseEl.innerHTML = formatWorkoutPlanAsHTML(plan);
            saveBtn.disabled = false;
            
            // Show chat
            workoutChatHistory = []; // Reset history
            workoutChatHistoryEl.innerHTML = ""; // Clear UI
            workoutChatWidget.classList.remove('hidden'); // Show widget
            
        } catch (error) {
            apiResponseEl.innerHTML = `<p style="color: var(--error);">Error: ${error.message}</p>`;
        } finally {
            workoutGenBtn.disabled = false;
            workoutGenBtn.textContent = "Generate Plan";
        }
    }

    async function generateNutrition() {
        if (!currentUserEmail) {
            nutritionResponseEl.innerHTML = `<p style="color: var(--error);">You must be logged in to generate a plan.</p>`;
            return;
        }
        
        nutritionGenBtn.disabled = true;
        nutritionGenBtn.textContent = "Generating...";
        nutritionResponseEl.innerHTML = `<p>Generating your nutrition plan...</p>`;
        
        const formData = {
            goal: document.getElementById('nutri-goal').value,
            weight_kg: parseFloat(document.getElementById('nutri-weight').value),
            height_cm: parseFloat(document.getElementById('nutri-height').value),
            age: parseInt(document.getElementById('nutri-age').value),
            activity_level: document.getElementById('nutri-activity').value,
            preferences: document.getElementById('nutri-prefs').value
        };

        try {
            const plan = await apiFetch('/generate-nutrition-plan', {
                method: 'POST',
                body: JSON.stringify(formData)
            });
            
            currentNutritionPlan = plan; // Store state
            nutritionResponseEl.innerHTML = formatNutritionPlanAsHTML(plan);
            saveNutritionBtn.disabled = false; // Enable save button
            
            nutritionChatHistory = []; // Reset history
            nutritionChatHistoryEl.innerHTML = ""; // Clear UI
            nutritionChatWidget.classList.remove('hidden'); // Show widget
            
        } catch (error) {
            console.error("Error generating nutrition plan:", error);
            nutritionResponseEl.innerHTML = `<p style="color: var(--error);">Error: ${error.message}</p>`;
        } finally {
            nutritionGenBtn.disabled = false;
            nutritionGenBtn.textContent = "Generate Nutrition Plan";
        }
    }

    async function evaluateProgress() {
        if (!currentUserEmail) {
            evalResponseEl.innerHTML = `<p style="color: var(--error);">You must be logged in to evaluate progress.</p>`;
            return;
        }

        if (!currentPlan || Object.keys(currentPlan).length === 0 || allCheckIns.length === 0) {
            evalResponseEl.innerHTML = `<p style="color: var(--error);">No plan or check-ins found. Save/upload a plan and log progress first.</p>`;
            return;
        }
        
        evaluateBtn.disabled = true;
        evaluateBtn.textContent = "Evaluating...";
        evalResponseEl.innerHTML = `<p>Evaluating your progress...</p>`;

        try {
            const evaluation = await apiFetch('/evaluate-plan', {
                method: 'POST',
                body: JSON.stringify({
                    original_plan: currentPlan, // Use state variable
                    check_ins: allCheckIns       // Use state variable
                })
            });
            evalResponseEl.innerHTML = formatEvaluationAsHTML(evaluation);
        } catch (error) {
            console.error("Error evaluating progress:", error);
            evalResponseEl.innerHTML = `<p style="color: var(--error);">Error: ${error.message}</p>`;
        } finally {
            evaluateBtn.disabled = false;
            evaluateBtn.textContent = "Evaluate Progress";
        }
    }
    
    async function loadExercises() {
        try {
            const exercises = await apiFetch('/exercises');
            exerciseSelect.innerHTML = '<option value="">Select an exercise...</option>'; // Clear "loading"
            exercises.forEach(ex => {
                const option = document.createElement('option');
                option.value = ex;
                option.textContent = ex;
                exerciseSelect.appendChild(option);
            });
        } catch (error) {
            console.error("Error loading exercises:", error);
            exerciseSelect.innerHTML = '<option value="">Could not load exercises</option>';
        }
    }
    
    // --- *** UPDATED Form Analysis function for STREAMING *** ---
    async function analyzeForm(event) {
        event.preventDefault();
        if (!currentUserEmail) {
            formAnalysisResponseEl.innerHTML = `<p style="color: var(--error);">You must be logged in to analyze form.</p>`;
            return;
        }

        const exercise = exerciseSelect.value;
        const videoFile = videoUpload.files[0];

        if (!exercise) {
            formAnalysisResponseEl.innerHTML = `<p style="color: var(--error);">Please select an exercise.</p>`;
            return;
        }
        if (!videoFile) {
            formAnalysisResponseEl.innerHTML = `<p style="color: var(--error);">Please upload a video file.</p>`;
            return;
        }

        analyzeFormBtn.disabled = true;
        analyzeFormBtn.textContent = "Analyzing...";
        // Show and reset progress bar
        progressContainer.classList.remove('hidden');
        progressStatus.textContent = "Uploading video...";
        progressBar.style.width = "5%"; // Start with a small amount
        formAnalysisResponseEl.innerHTML = ""; // Clear previous results

        const formData = new FormData();
        formData.append('exercise_name', exercise);
        formData.append('video', videoFile);

        try {
            const response = await fetch(`${API_URL}/analyze-form`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                // Handle non-streaming errors (e.g., 400, 500)
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }

            // --- Start reading the stream ---
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = ''; // To store incomplete JSON chunks

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break; // Stream finished
                }

                buffer += decoder.decode(value, { stream: true });
                
                // Process all complete JSON objects in the buffer (split by newline)
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex);
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.trim() === "") continue;

                    try {
                        const progressUpdate = JSON.parse(line);
                        
                        // Update UI based on the streamed object
                        progressStatus.textContent = progressUpdate.message;
                        progressBar.style.width = `${progressUpdate.percent}%`;

                        if (progressUpdate.status === 'complete') {
                            // This is the final message with the data
                            formAnalysisResponseEl.innerHTML = formatFormAnalysisAsHTML(progressUpdate.data);
                            progressContainer.classList.add('hidden'); // Hide progress on complete
                        }
                        if (progressUpdate.status === 'error') {
                            throw new Error(progressUpdate.message);
                        }

                    } catch (e) {
                        console.warn("Error parsing stream chunk:", line, e);
                        // Don't throw, just log and continue
                    }
                }
            }

        } catch (error) {
            console.error("Error analyzing form:", error);
            formAnalysisResponseEl.innerHTML = `<p style="color: var(--error);">Error: ${error.message}</p>`;
            progressContainer.classList.add('hidden'); // Hide progress on error
        } finally {
            analyzeFormBtn.disabled = false;
            analyzeFormBtn.textContent = "Analyze Form";
        }
    }
    
    // --- NEW: Save Button Logic ---
    function handleSaveWorkoutClick() {
        if (loginMode === 'google') {
            savePlanToGoogleDrive();
        } else if (loginMode === 'tester') {
            saveAllDataToExcel();
        }
    }
    
    // --- UPDATED: Save ALL data to Excel ---
    function saveAllDataToExcel() {
        if (!currentPlan && !currentNutritionPlan) {
          saveStatus.textContent = "No plan to save.";
          return;
        }

        saveBtn.disabled = true;
        saveNutritionBtn.disabled = true;
        const statusEl = saveStatus.textContent ? saveStatus : saveNutritionStatus;
        statusEl.textContent = "Generating Excel file...";

        try {
            const wb = XLSX.utils.book_new();

            // Sheet 1 & 2: Workout Data
            if (currentPlan) {
                const planData = [{ plan_json: JSON.stringify(currentPlan) }];
                const ws_plan_data = XLSX.utils.json_to_sheet(planData);
                XLSX.utils.book_append_sheet(wb, ws_plan_data, "Plan_Data");

                const friendlyData = getFriendlyPlanData(currentPlan);
                const ws_plan_readable = XLSX.utils.aoa_to_sheet(friendlyData);
                XLSX.utils.book_append_sheet(wb, ws_plan_readable, "Workout Plan");
            }
            
            // Sheet 3 & 4: Nutrition Data
            if (currentNutritionPlan) {
                const nutriData = [{ nutrition_json: JSON.stringify(currentNutritionPlan) }];
                const ws_nutri_data = XLSX.utils.json_to_sheet(nutriData);
                XLSX.utils.book_append_sheet(wb, ws_nutri_data, "Nutrition_Data");
                
                const friendlyNutriData = getFriendlyNutritionData(currentNutritionPlan);
                const ws_nutri_readable = XLSX.utils.aoa_to_sheet(friendlyNutriData);
                XLSX.utils.book_append_sheet(wb, ws_nutri_readable, "Nutrition Plan");
            }

            // Sheet 5: Check-in Data
            const checkInData = allCheckIns.length > 0 ? allCheckIns : [{ Date: "No check-ins yet" }];
            const ws_checkins = XLSX.utils.json_to_sheet(checkInData);
            XLSX.utils.book_append_sheet(wb, ws_checkins, "CheckIns");
            
            // Download the file
            XLSX.writeFile(wb, "Jimbo_Data.xlsx");
            
            statusEl.textContent = "✅ File downloaded as Jimbo_Data.xlsx";
        } catch (e) {
            console.error("Error saving to Excel:", e);
            statusEl.textContent = `❌ Error: ${e.message}`;
        } finally {
            if(currentPlan) saveBtn.disabled = false;
            if(currentNutritionPlan) saveNutritionBtn.disabled = false;
        }
    }

    // --- UPDATED: Tester Mode Upload from Excel ---
    function loadDataFromExcel(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                
                let loadedPlans = 0;
                let loadedCheckins = 0;

                // 1. Load Workout Plan
                const planSheet = workbook.Sheets["Plan_Data"];
                if (planSheet) {
                    const planData = XLSX.utils.sheet_to_json(planSheet);
                    if (planData.length > 0 && planData[0].plan_json) {
                        currentPlan = JSON.parse(planData[0].plan_json);
                        apiResponseEl.innerHTML = formatWorkoutPlanAsHTML(currentPlan);
                        saveBtn.disabled = false;
                        loadedPlans++;
                    }
                }

                // 2. Load Nutrition Plan
                const nutritionSheet = workbook.Sheets["Nutrition_Data"];
                if (nutritionSheet) {
                    const nutriData = XLSX.utils.sheet_to_json(nutritionSheet);
                    if (nutriData.length > 0 && nutriData[0].nutrition_json) {
                        currentNutritionPlan = JSON.parse(nutriData[0].nutrition_json);
                        nutritionResponseEl.innerHTML = formatNutritionPlanAsHTML(currentNutritionPlan);
                        saveNutritionBtn.disabled = false;
                        loadedPlans++;
                    }
                }
                
                // 3. Load Check-Ins
                const checkInSheet = workbook.Sheets["CheckIns"];
                if (checkInSheet) {
                    const checkInData = XLSX.utils.sheet_to_json(checkInSheet);
                    allCheckIns = checkInData.filter(row => row.Date !== "No check-ins yet");
                    renderCheckins(allCheckIns);
                    loadedCheckins = allCheckIns.length;
                }
                
                uploadStatus.textContent = `✅ Success! Loaded ${loadedPlans} plan(s) and ${loadedCheckins} check-in(s).`;
                uploadFileName.textContent = file.name;

            } catch (err) {
                console.error("Error reading Excel file:", err);
                uploadStatus.textContent = `❌ Error: ${err.message}`;
                uploadFileName.textContent = "Choose .xlsx file...";
            }
        };
        reader.onerror = (e) => {
             uploadStatus.textContent = `❌ Error reading file.`;
        };
        reader.readAsBinaryString(file);
    }

    // --- GOOGLE SHEETS & DRIVE LOGIC (Streamlined) ---

    async function loadUserDataFromDrive() {
        apiResponseEl.innerHTML = `<p>Checking Google Drive for data...</p>`;
        // We already have a token from the initial login, so gapi.client.setToken
        // has already been called. We can just make the calls.
        try {
            const file = await findSpreadsheet();
            if (file) {
                spreadsheetId = file.id;
                apiResponseEl.innerHTML = `<p>Data file found. Loading...</p>`;
                
                // UPDATE: Add 2 new ranges
                const sheetData = await gapi.client.sheets.spreadsheets.values.batchGet({
                    spreadsheetId: spreadsheetId,
                    ranges: ['Plan_Data!A1', 'CheckIns!A:Z', 'Nutrition_Data!A1'],
                });
                
                const valueRanges = sheetData.result.valueRanges;
                
                // Index 0: Workout Plan
                const planRows = valueRanges[0] ? valueRanges[0].values : null;
                if (planRows && planRows.length > 0 && planRows[0][0]) {
                    currentPlan = JSON.parse(planRows[0][0]);
                    apiResponseEl.innerHTML = formatWorkoutPlanAsHTML(currentPlan);
                    saveBtn.disabled = false;
                } else {
                    apiResponseEl.innerHTML = `<p>No plan saved yet. Generate one!</p>`;
                }
                
                // Index 1: Check-Ins
                const checkInRows = valueRanges[1] ? valueRanges[1].values : null;
                if (checkInRows && checkInRows.length > 1) { // 1 for header
                    allCheckIns = checkInRows.slice(1).map(row => ({
                        date: row[0],
                        weight_kg: row[1] || null,
                        notes: row[2]
                    })).reverse(); // Show newest first
                    renderCheckins(allCheckIns);
                } else {
                    renderCheckins([]);
                }
                
                // NEW - Index 2: Nutrition Plan
                const nutritionRows = valueRanges[2] ? valueRanges[2].values : null;
                if (nutritionRows && nutritionRows.length > 0 && nutritionRows[0][0]) {
                    currentNutritionPlan = JSON.parse(nutritionRows[0][0]);
                    nutritionResponseEl.innerHTML = formatNutritionPlanAsHTML(currentNutritionPlan);
                    saveNutritionBtn.disabled = false;
                } else {
                    nutritionResponseEl.innerHTML = `<p>No nutrition plan saved yet. Generate one!</p>`;
                }
                
            } else {
                apiResponseEl.innerHTML = `<p>No data file found. Save a plan to create one.</p>`;
                renderCheckins([]);
            }
        } catch (e) {
            console.error("Error in loadUserDataFromDrive:", e);
            apiResponseEl.innerHTML = `<p style="color: var(--error);">Error loading data from Sheet: ${e.message}</p>`;
        }
    }

    async function findSpreadsheet() {
        const response = await gapi.client.drive.files.list({
            q: `name='${SPREADSHEET_FILE_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and 'root' in parents and trashed=false`,
            fields: 'files(id, name)',
        });
        if (response.result.files && response.result.files.length > 0) {
            return response.result.files[0];
        }
        return null;
    }
    
    async function createSpreadsheet() {
        const response = await gapi.client.sheets.spreadsheets.create({
            properties: { title: SPREADSHEET_FILE_NAME },
            sheets: [
                { properties: { title: 'Workout Plan' } }, // Sheet for user viewing
                { properties: { title: 'Nutrition Plan' } }, // New sheet for user viewing
                { properties: { title: 'CheckIns' } },
                { properties: { title: 'Plan_Data' } },     // Sheet for machine reading
                { properties: { title: 'Nutrition_Data' } }  // New sheet for machine reading
            ]
        });
        spreadsheetId = response.result.spreadsheetId;
        
        // Add headers for CheckIns sheet
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheetId,
            range: 'CheckIns!A1:C1',
            valueInputOption: 'RAW',
            resource: {
                values: [['Date', 'Weight (kg)', 'Notes']]
            }
        });
        return spreadsheetId;
    }

    function savePlanToGoogleDrive() {
        if (!currentPlan) {
          saveStatus.textContent = "No plan to save.";
          return;
        }
        saveStatus.textContent = "Requesting Google Drive access...";
        saveBtn.disabled = true;

        // This will request a token (or use a cached one) and run _doSavePlanToGoogle
        getAccessToken(_doSavePlanToGoogle); 
    }
    
    async function _doSavePlanToGoogle() {
        // This function only runs *after* getAccessToken is successful
        try {
            if (!spreadsheetId) {
              saveStatus.textContent = "Checking for existing file...";
              const file = await findSpreadsheet();
              if (file) {
                spreadsheetId = file.id;
              } else {
                saveStatus.textContent = "No file found. Creating new one...";
                spreadsheetId = await createSpreadsheet();
              }
            }

            // 1. Prepare JSON data for machine reading
            const planAsJsonString = JSON.stringify(currentPlan);
            const machineData = {
              range: 'Plan_Data!A1', // Write to Plan_Data sheet
              values: [[planAsJsonString]]
            };

            // 2. Prepare data for human reading
            const friendlyData = getFriendlyPlanData(currentPlan);
            const humanData = {
                range: 'Workout Plan!A1', // Write to Workout Plan sheet
                values: friendlyData
            };
            
            // Clear old content of 'Workout Plan' sheet before overwriting
            await gapi.client.sheets.spreadsheets.values.clear({
                spreadsheetId: spreadsheetId,
                range: 'Workout Plan' 
            });

            // 3. Perform batchUpdate to write both
            saveStatus.textContent = "Saving plan to Google Sheet...";
            await gapi.client.sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: spreadsheetId,
              resource: {
                valueInputOption: 'USER_ENTERED', // Use USER_ENTERED to let Google auto-format
                data: [
                    machineData, // JSON data package
                    humanData    // Friendly table data package
                ]
              }
            });

            saveStatus.innerHTML = `✅ <strong>Success!</strong> Plan saved.<br>
              <a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}" target="_blank" 
              style="color: var(--purple-light); text-decoration: underline;">
                Open Sheet
              </a>`;
        } catch (e) {
            console.error("Error in _doSavePlanToGoogle:", e);
            saveStatus.textContent = `❌ Error saving plan: ${e.message}`;
        } finally {
            saveBtn.disabled = false;
        }
    }
    
    // --- NEW NUTRITION SAVE FUNCTIONS ---
    
    function handleSaveNutritionClick() {
        if (loginMode === 'google') {
            saveNutritionToGoogleDrive();
        } else if (loginMode === 'tester') {
            saveAllDataToExcel(); // Both buttons call the same Excel save function
        }
    }

    function saveNutritionToGoogleDrive() {
        if (!currentNutritionPlan) {
          saveNutritionStatus.textContent = "No nutrition plan to save.";
          return;
        }
        saveNutritionStatus.textContent = "Requesting Google Drive access...";
        saveNutritionBtn.disabled = true;

        getAccessToken(_doSaveNutritionToGoogle); 
    }
    
    async function _doSaveNutritionToGoogle() {
        try {
            if (!spreadsheetId) {
              saveNutritionStatus.textContent = "Checking for existing file...";
              const file = await findSpreadsheet();
              if (file) {
                spreadsheetId = file.id;
              } else {
                saveNutritionStatus.textContent = "No file found. Creating new one...";
                spreadsheetId = await createSpreadsheet();
              }
            }

            // 1. Prepare JSON data for machine reading
            const planAsJsonString = JSON.stringify(currentNutritionPlan);
            const machineData = {
              range: 'Nutrition_Data!A1', // Write to Nutrition_Data sheet
              values: [[planAsJsonString]]
            };

            // 2. Prepare data for human reading
            const friendlyData = getFriendlyNutritionData(currentNutritionPlan);
            const humanData = {
                range: 'Nutrition Plan!A1', // Write to Nutrition Plan sheet
                values: friendlyData
            };
            
            // Clear old content of 'Nutrition Plan' sheet
            await gapi.client.sheets.spreadsheets.values.clear({
                spreadsheetId: spreadsheetId,
                range: 'Nutrition Plan' 
            });

            // 3. Perform batchUpdate
            saveNutritionStatus.textContent = "Saving nutrition plan...";
            await gapi.client.sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: spreadsheetId,
              resource: {
                valueInputOption: 'USER_ENTERED',
                data: [ machineData, humanData ]
              }
            });

            saveNutritionStatus.innerHTML = `✅ <strong>Success!</strong> Plan saved.`;
        } catch (e) {
            const errorMsg = e.result?.error?.message || e.message || 'An unknown error occurred';
            console.error("Error in _doSaveNutritionToGoogle:", JSON.stringify(e)); // Log the full error
            saveNutritionStatus.textContent = `❌ Error saving plan: ${errorMsg}`;  
        } finally {
            saveNutritionBtn.disabled = false;
        }
    }


    // --- NEW: Check-in Logic Router ---
    function handleCheckinSubmit(e) {
        e.preventDefault();
        const checkinBtn = checkinForm.querySelector('button[type="submit"]');
        checkinBtn.disabled = true;
        checkinBtn.textContent = "Saving...";

        if (loginMode === 'google') {
            getAccessToken(() => _doAddCheckinToGoogle(checkinBtn));
        } else if (loginMode === 'tester') {
            _doAddCheckinLocally(checkinBtn);
        }
    }
    
    // --- NEW: Tester Mode Local Check-in ---
    function _doAddCheckinLocally(checkinBtn) {
        const checkinData = {
            date: document.getElementById('checkin-date').value,
            weight_kg: document.getElementById('checkin-weight').value || "",
            notes: document.getElementById('checkin-notes').value,
        };
        if (!checkinData.date || !checkinData.notes) {
            alert("Date and Notes are required.");
            checkinBtn.disabled = false;
            checkinBtn.textContent = "Log Check-In";
            return;
        }
        
        allCheckIns.unshift(checkinData); // Add to front
        renderCheckins(allCheckIns);
        checkinForm.reset();
        
        checkinBtn.disabled = false;
        checkinBtn.textContent = "Log Check-In";
        saveStatus.textContent = "Check-in added. Download data to save.";
        if(saveBtn.disabled) saveStatus.textContent = "Check-in added. Generate and save a plan to download.";
    }

    async function _doAddCheckinToGoogle(checkinBtn) {
        const checkinData = {
            date: document.getElementById('checkin-date').value,
            weight_kg: document.getElementById('checkin-weight').value || "", // Send empty string for empty cell
            notes: document.getElementById('checkin-notes').value,
        };
        if (!checkinData.date || !checkinData.notes) {
            alert("Date and Notes are required.");
            checkinBtn.disabled = false;
            checkinBtn.textContent = "Log Check-In";
            return;
        }

        try {
            if (!spreadsheetId) {
                const file = await findSpreadsheet();
                if(file) {
                    spreadsheetId = file.id;
                } else {
                    const newSheetId = await createSpreadsheet();
                    spreadsheetId = newSheetId.spreadsheetId || newSheetId;
                }
            }

            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'CheckIns!A:C',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: [[checkinData.date, checkinData.weight_kg, checkinData.notes]]
                }
            });
            
            allCheckIns.unshift(checkinData); // Add to front
            renderCheckins(allCheckIns);
            checkinForm.reset();
            
        } catch (e) {
            console.error("Error in _doAddCheckinToGoogle:", e);
            alert(`Error saving check-in: ${e.message}`);
        } finally {
            checkinBtn.disabled = false;
            checkinBtn.textContent = "Log Check-In";
        }
    }
    
    // --- NEW CHAT HANDLER FUNCTIONS ---
    
    // Helper to add a message to the chat UI
    function appendToChatHistory(el, message, role) {
        const p = document.createElement('p');
        p.classList.add(role === 'user' ? 'chat-user' : 'chat-ai');
        p.innerHTML = `<strong>${role === 'user' ? 'You' : 'Jimbo'}:</strong> ${message}`;
        el.appendChild(p);
        el.scrollTop = el.scrollHeight; // Auto-scroll to bottom
    }

    async function handleWorkoutChatSend() {
        const message = workoutChatInput.value.trim();
        if (!message || !currentPlan) return;

        workoutChatInput.value = ""; // Clear input
        appendToChatHistory(workoutChatHistoryEl, message, 'user');
        workoutChatHistory.push({ role: 'user', content: message });

        try {
            const data = await apiFetch('/chat-with-plan', {
                method: 'POST',
                body: JSON.stringify({
                    context_plan: currentPlan,
                    history: workoutChatHistory,
                    message: message
                })
            });
            
            const aiResponse = data.response;
            appendToChatHistory(workoutChatHistoryEl, aiResponse, 'ai');
            workoutChatHistory.push({ role: 'ai', content: aiResponse });

        } catch (error) {
            appendToChatHistory(workoutChatHistoryEl, `Error: ${error.message}`, 'ai');
        }
    }

    async function handleNutritionChatSend() {
        const message = nutritionChatInput.value.trim();
        if (!message || !currentNutritionPlan) return;

        nutritionChatInput.value = ""; // Clear input
        appendToChatHistory(nutritionChatHistoryEl, message, 'user');
        nutritionChatHistory.push({ role: 'user', content: message });

        try {
            const data = await apiFetch('/chat-with-plan', {
                method: 'POST',
                body: JSON.stringify({
                    context_plan: currentNutritionPlan,
                    history: nutritionChatHistory,
                    message: message
                })
            });
            
            const aiResponse = data.response;
            appendToChatHistory(nutritionChatHistoryEl, aiResponse, 'ai');
            nutritionChatHistory.push({ role: 'ai', content: aiResponse });

        } catch (error) {
            appendToChatHistory(nutritionChatHistoryEl, `Error: ${error.message}`, 'ai');
        }
    }


    // --- EVENT LISTENERS ---
    signOutBtn.addEventListener('click', signOutUser);
    testerLoginBtn.addEventListener('click', loginAsTester); // NEW
    
    workoutForm.addEventListener('submit', (e) => { e.preventDefault(); generateWorkout(); });
    nutritionForm.addEventListener('submit', (e) => { e.preventDefault(); generateNutrition(); });
    checkinForm.addEventListener('submit', handleCheckinSubmit); // UPDATED
    
    saveBtn.addEventListener('click', handleSaveWorkoutClick); // UPDATED
    saveNutritionBtn.addEventListener('click', handleSaveNutritionClick); // NEW
    
    evaluateBtn.addEventListener('click', evaluateProgress);
    formAnalysisForm.addEventListener('submit', analyzeForm);
    
    // Chat Listeners
    workoutChatSend.addEventListener('click', handleWorkoutChatSend);
    nutritionChatSend.addEventListener('click', handleNutritionChatSend);
    // Allow sending with Enter key
    workoutChatInput.addEventListener('keypress', (e) => e.key === 'Enter' && handleWorkoutChatSend());
    nutritionChatInput.addEventListener('keypress', (e) => e.key === 'Enter' && handleNutritionChatSend());
    
    
    // File input listeners
    videoUpload.addEventListener('change', () => {
        if (videoUpload.files.length > 0) {
            fileNameDisplay.textContent = videoUpload.files[0].name;
            fileNameDisplay.style.color = 'var(--text)';
        } else {
            fileNameDisplay.textContent = 'Choose a video file...';
            fileNameDisplay.style.color = '#888';
        }
    });
    
    // NEW: Tester mode file upload listener
    uploadDataFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            uploadFileName.textContent = file.name;
            loadDataFromExcel(file);
        }
    });


    // Listen for our custom sign-in event
    document.addEventListener('google-signin-success', (event) => {
        const processLogin = () => {
            if (isAppInitialized) {
                console.log("Processing login via event listener...");
                const userData = event.detail;
                if(currentUserEmail) return; // Already processed
                
                window.pendingGoogleLogin = null; // Clear pending
                loginMode = 'google'; // <-- NEW: Set login mode
                currentUserEmail = userData.email;
                showAppUI(currentUserEmail); // This now triggers the auth flow
            } else {
                setTimeout(processLogin, 100);
            }
        };
        processLogin();
    });
    
    // Tab navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            item.classList.add('active');
            const tab = item.getAttribute('data-tab');
            document.getElementById(tab).classList.add('active');
            document.getElementById('page-title').textContent = item.querySelector('.nav-text').textContent;
        });
    });

    // --- INITIALIZATION FUNCTION ---
    async function initializeApp() {
        try {
            // 1. Fetch the Client ID from our backend
            const response = await fetch(`${API_URL}/config`);
            if (!response.ok) {
                let errorMsg = `Server error: ${response.status}`;
                try {
                    const errData = await response.json();
                    errorMsg = errData.error || errorMsg;
                } catch (e) { /* ignore parse error */ }
                throw new Error(errorMsg);
            }
            const config = await response.json();
            
            CLIENT_ID = config.google_client_id;
            
            if (!CLIENT_ID) {
                throw new Error("Google Client ID not loaded from server. Check .env file on backend.");
            }

            // 2. Wait for Google scripts to be ready
            const checkGoogle = (callback) => {
                if (window.google && window.google.accounts) {
                    callback();
                } else {
                    console.log("Waiting for Google scripts to load...");
                    setTimeout(() => checkGoogle(callback), 100);
                }
            };
            
            checkGoogle(() => {
                try {
                    // 3. Initialize the Token Client (for Sheets/Drive)
                    tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: CLIENT_ID,
                        scope: GOOGLE_SCOPES,
                        callback: '', // Will be set dynamically by getAccessToken
                    });

                    // 4. Assign click event to your new login button
                    const googleLoginButton = document.getElementById('google-login-btn');
                    if (googleLoginButton) {
                        googleLoginButton.addEventListener('click', () => {
                            // Disable button to prevent double clicks
                            googleLoginButton.disabled = true;
                            googleLoginButton.textContent = "Connecting...";

                            // Start the login AND authorization flow
                            getAccessToken(handleLoginAndAuthorization);
                        });
                    }
                    
                    // 5. SET THE APP AS INITIALIZED
                    isAppInitialized = true;
                    console.log("Application is initialized.");
                } catch(e) {
                    console.error("Error during Google init:", e);
                    authError.textContent = `Error during Google init: ${e.message}`;
                }
            });

        } catch (error) {
            console.error("Initialization failed:", error);
            authError.textContent = `Error: ${error.message}`;
            googleSignInBtn.innerHTML = `<p style="color: var(--error);">${error.message}</p>`;
        }
    }
    
    // --- START THE APP ---
    initializeApp();
    
});

const sidebar = document.querySelector('.sidebar');
const main = document.querySelector('.main');
const toggleBtn = document.getElementById('sidebar-toggle');

toggleBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  main.classList.toggle('collapsed');
});

// === LANDING → MODAL LOGIN (ĐÃ SỬA HOÀN CHỈNH) ===
document.getElementById('start-btn')?.addEventListener('click', () => {
  const modal = document.getElementById('login-modal');
  modal.classList.remove('hidden');     // BỎ hidden đi
  modal.classList.add('active');         // Hiện modal
  document.getElementById('landing-page').style.filter = 'blur(8px)';
});

// Đóng modal
document.querySelector('.modal-close')?.addEventListener('click', () => {
  const modal = document.getElementById('login-modal');
  modal.classList.add('hidden');         // Thêm lại hidden
  modal.classList.remove('active');
  document.getElementById('landing-page').style.filter = 'blur(0)';
});

// Đóng khi click ngoài
document.getElementById('login-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('login-modal')) {
    document.querySelector('.modal-close').click(); // Gọi nút đóng luôn cho gọn
  }
});