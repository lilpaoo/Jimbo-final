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
    let currentUserEmail = null;
    let tokenClient = null;     // Google's token client
    let spreadsheetId = null;   // The ID of the user's data file

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

    // Nutrition Tab
    const nutritionForm = document.getElementById('nutrition-form');
    const nutritionResponseEl = document.getElementById('nutrition-response');
    const nutritionGenBtn = document.getElementById('nutrition-generate-btn');

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
        return;
      }
      
      // --- NEW: Simplified Callback Handling ---
      tokenClient.callback = async (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          console.log("✅ Got access token. Setting for GAPI.");
          await waitForGapi(); // ensure gapi is ready before using
          
          // --- NEW: Automatically set token for all future gapi calls ---
          gapi.client.setToken({ access_token: tokenResponse.access_token });
          
          // Run the original function (e.g., savePlan)
          callback();
          
        } else if (tokenResponse.error) {
           console.error("Token Error:", tokenResponse.error, tokenResponse.error_description);
           alert(`Error getting permission: ${tokenResponse.error_description || tokenResponse.error}. Check popup blocker?`);
           // Re-enable buttons if auth fails
           saveBtn.disabled = false;
           checkinForm.querySelector('button[type="submit"]').disabled = false;
        } else {
          console.error("❌ No access token returned:", tokenResponse);
          alert("Failed to get Google access token. Try signing in again.");
        }
      };
        
        // Check if we already have permission.
        const hasGrantedScopes = google.accounts.oauth2.hasGrantedAllScopes(tokenClient, GOOGLE_SCOPES);

        if (hasGrantedScopes) {
            // We already have permission, just get a token silently
            console.log("Already have scopes, requesting token silently.");
            tokenClient.requestAccessToken({prompt: ''});
        } else {
            // We need to ask for permission
            // This will show the popup
            console.log("Don't have scopes, requesting user consent.");
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
        allCheckIns = [];
        spreadsheetId = null;
        isAppInitialized = false; // Reset the app state
        loginMode = null; // <-- NEW: Reset login mode
        if (window.google) google.accounts.id.disableAutoSelect();
        showAuthUI();
        // Re-initialize the app in case they want to log in again
        initializeApp();
    }

    // --- UI TOGGLING ---
    function showAppUI(email) {
        userEmail.textContent = email;
        userEmailSidebar.textContent = email.split('@')[0]; // Show username
        mainAppContainer.classList.remove('hidden');
        authContainer.style.display = 'none'; // Use style.display to match auth logic
        authError.textContent = "";
        
        // --- NEW: UI changes based on loginMode ---
        if (loginMode === 'google') {
            pageSubtitle.textContent = "Your data is saved securely to your Google Drive.";
            saveBtn.textContent = "Save Plan to Google Drive";
            testerUploadSection.classList.add('hidden');
            
            // On login, get permissions *immediately*
            console.log("App shown. Now getting initial access token and loading data.");
            getAccessToken(() => {
                console.log("Initial auth successful.");
                loadUserDataFromDrive();
            });
            
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


    // --- CORE APP LOGIC (API Calls) ---
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
            nutritionResponseEl.innerHTML = formatNutritionPlanAsHTML(plan);
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
    function handleSaveClick() {
        if (loginMode === 'google') {
            savePlanToGoogleDrive();
        } else if (loginMode === 'tester') {
            savePlanToExcel();
        }
    }
    
    // --- NEW: Tester Mode Save to Excel ---
    function savePlanToExcel() {
        if (!currentPlan) {
          saveStatus.textContent = "No plan to save.";
          return;
        }
        saveBtn.disabled = true;
        saveStatus.textContent = "Generating Excel file...";

        try {
            // Create data in the format SheetJS expects (array of objects)
            // We wrap the plan JSON in an object for the sheet
            const planData = [{ plan_json: JSON.stringify(currentPlan) }];
            // Check-ins are already an array of objects
            const checkInData = allCheckIns.length > 0 ? allCheckIns : [{ Date: "No check-ins yet" }];

            // Create worksheets
            const ws_plan = XLSX.utils.json_to_sheet(planData);
            const ws_checkins = XLSX.utils.json_to_sheet(checkInData);
            
            // Create a new workbook
            const wb = XLSX.utils.book_new();
            
            // Add worksheets to the workbook
            XLSX.utils.book_append_sheet(wb, ws_plan, "Plan");
            XLSX.utils.book_append_sheet(wb, ws_checkins, "CheckIns");
            
            // Write the workbook and trigger a download
            XLSX.writeFile(wb, "Jimbo_Data.xlsx");
            
            saveStatus.textContent = "✅ File downloaded as Jimbo_Data.xlsx";
        } catch (e) {
            console.error("Error saving to Excel:", e);
            saveStatus.textContent = `❌ Error: ${e.message}`;
        } finally {
            saveBtn.disabled = false;
        }
    }

    // --- NEW: Tester Mode Upload from Excel ---
    function loadDataFromExcel(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                
                // 1. Load Plan
                const planSheet = workbook.Sheets["Plan"];
                if (!planSheet) throw new Error("Missing 'Plan' sheet in file.");
                const planData = XLSX.utils.sheet_to_json(planSheet);
                
                if (planData.length > 0 && planData[0].plan_json) {
                    currentPlan = JSON.parse(planData[0].plan_json);
                    apiResponseEl.innerHTML = formatWorkoutPlanAsHTML(currentPlan);
                    saveBtn.disabled = false;
                } else {
                    throw new Error("Could not find plan data in 'Plan' sheet.");
                }
                
                // 2. Load Check-Ins
                const checkInSheet = workbook.Sheets["CheckIns"];
                if (!checkInSheet) throw new Error("Missing 'CheckIns' sheet in file.");
                const checkInData = XLSX.utils.sheet_to_json(checkInSheet);

                // Filter out any placeholder data
                allCheckIns = checkInData.filter(row => row.Date !== "No check-ins yet");
                renderCheckins(allCheckIns);
                
                uploadStatus.textContent = `✅ Success! Loaded ${allCheckIns.length} check-ins and 1 plan.`;
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
                
                const sheetData = await gapi.client.sheets.spreadsheets.values.batchGet({
                    spreadsheetId: spreadsheetId,
                    ranges: ['Plan!A:Z', 'CheckIns!A:Z'],
                });
                
                const planRows = sheetData.result.valueRanges[0].values;
                if (planRows && planRows.length > 0 && planRows[0][0]) {
                    currentPlan = JSON.parse(planRows[0][0]);
                    apiResponseEl.innerHTML = formatWorkoutPlanAsHTML(currentPlan);
                    saveBtn.disabled = false;
                } else {
                    apiResponseEl.innerHTML = `<p>No plan saved yet. Generate one!</p>`;
                }
                
                const checkInRows = sheetData.result.valueRanges[1].values;
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
                { properties: { title: 'Plan' } },
                { properties: { title: 'CheckIns' } }
            ]
        });
        spreadsheetId = response.result.spreadsheetId;
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

        // This will request a token (or use a cached one) and run _doSavePlan
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

            const planAsJsonString = JSON.stringify(currentPlan);
            const data = [{
              range: 'Plan!A1',
              values: [[planAsJsonString]]
            }];

            saveStatus.textContent = "Saving plan to Google Sheet...";
            await gapi.client.sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: spreadsheetId,
              resource: {
                valueInputOption: 'RAW',
                data: data
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

    // --- EVENT LISTENERS ---
    signOutBtn.addEventListener('click', signOutUser);
    testerLoginBtn.addEventListener('click', loginAsTester); // NEW
    
    workoutForm.addEventListener('submit', (e) => { e.preventDefault(); generateWorkout(); });
    nutritionForm.addEventListener('submit', (e) => { e.preventDefault(); generateNutrition(); });
    checkinForm.addEventListener('submit', handleCheckinSubmit); // UPDATED
    saveBtn.addEventListener('click', handleSaveClick); // UPDATED
    evaluateBtn.addEventListener('click', evaluateProgress);
    formAnalysisForm.addEventListener('submit', analyzeForm);
    
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
                    // 3. Initialize Sign-In
                    google.accounts.id.initialize({
                        client_id: CLIENT_ID,
                        callback: window.onSignIn // Point to the global function
                    });
                    
                    // 4. Render the sign-in button
                    google.accounts.id.renderButton(
                        googleSignInBtn,
                        { theme: "outline", size: "large", type: "standard", text: "sign_in_with", shape: "rectangular", logo_alignment: "left" } 
                    );
                    
                    // 5. Initialize the Token Client (for Sheets/Drive)
                    tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: CLIENT_ID,
                        scope: GOOGLE_SCOPES,
                        callback: '', // Will be set dynamically by getAccessToken
                    });

                    // 6. SET THE APP AS INITIALIZED
                    isAppInitialized = true;
                    console.log("Application is initialized.");
                    
                    // 7. Check for a pending login (race condition fix)
                    if (window.pendingGoogleLogin) {
                        console.log("Processing pending login...");
                        const userData = window.pendingGoogleLogin;
                        window.pendingGoogleLogin = null; // Clear it
                        loginMode = 'google'; // <-- NEW: Set login mode
                        currentUserEmail = userData.email;
                        showAppUI(currentUserEmail);
                    }
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