import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// --- TYPE DEFINITIONS ---

type Question = {
  questionText: string;
  options: string[];
  correctAnswer: string;
  type: 'MCQ' | 'TITA';
};

type PassageGroup = {
  passage: string;
  questions: Question[];
};

type SectionItem = Question | PassageGroup;

type Section = {
  name: string;
  timeLimit: number;
  items: SectionItem[]; // This replaces the simple `questions` array
};

type TestData = {
  sections: Section[];
};

type AnswerStatus = 'not-answered' | 'answered' | 'marked';

type UserAnswer = {
  answer: string | null;
  status: AnswerStatus;
};

type UserAnswers = Record<number, Record<number, UserAnswer>>;

type TestType = 'Full Mock' | 'VARC' | 'DILR' | 'QA';
type SectionKey = 'varc' | 'dilr' | 'qa';
type TestStatus = 'Not Started' | 'In Progress' | 'Completed';

type FinalScore = {
  score: number;
  correct: number;
  incorrect: number;
  attempted: number;
};

type SavedTest = {
  id: string;
  name: string;
  type: TestType;
  status: TestStatus;
  testData: TestData;
  userAnswers: UserAnswers;
  timers: Record<number, number>;
  lastActiveSection: number;
  lockedSections?: Record<number, boolean>;
  finalScore?: FinalScore;
};

type AIAnalysisData = {
    explanation: string;
    difficulty: 'Easy' | 'Medium' | 'Hard' | string;
};

// --- UTILITY FUNCTIONS ---
const isPassageGroup = (item: SectionItem): item is PassageGroup => {
  return (item as PassageGroup).passage !== undefined;
};

const getProjectedRank = (score: number) => {
    // Data derived from "Table 4: CAT 2025: Projected Overall Score vs. Percentile and Rank" (Moderate Difficulty)
    const moderateProjection = [
        { scoreRange: [102, Infinity], percentile: '99.9', rank: '~300' },
        { scoreRange: [93, 101], percentile: '99.5', rank: '~1,500' },
        { scoreRange: [84, 92], percentile: '99.0', rank: '~3,000' },
        { scoreRange: [74, 83], percentile: '98.0', rank: '~6,000' },
        { scoreRange: [69, 73], percentile: '97.0', rank: '~9,000' },
        { scoreRange: [61, 68], percentile: '95.0', rank: '~15,000' },
        { scoreRange: [50, 60], percentile: '90.0', rank: '~30,000' },
        { scoreRange: [44, 49], percentile: '85.0', rank: '~45,000' },
        { scoreRange: [39, 43], percentile: '80.0', rank: '~60,000' },
    ];

    for (const p of moderateProjection) {
        if(score >= p.scoreRange[0] && score <= p.scoreRange[1]) {
            return { percentile: p.percentile, rank: p.rank };
        }
    }
    // Default case if score is below the lowest bound
    return { percentile: '<80.0', rank: '>60,000' };
}

// Robust JSON parser to handle AI adding extra text, control characters, or multiple JSON objects.
const parseJsonFromText = (text: string): any => {
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

    const firstBrace = cleanText.indexOf('{');
    const firstBracket = cleanText.indexOf('[');

    let startIndex = -1;
    let startChar: '{' | '[' | null = null;
    let endChar: '}' | ']' | null = null;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIndex = firstBrace;
        startChar = '{';
        endChar = '}';
    } else if (firstBracket !== -1) {
        startIndex = firstBracket;
        startChar = '[';
        endChar = ']';
    }

    if (startIndex === -1 || !startChar || !endChar) {
        throw new Error("Could not find a valid JSON object or array in the response.");
    }
    
    let balance = 0;
    let endIndex = -1;

    // This loop finds the end of the first complete JSON structure.
    for (let i = startIndex; i < cleanText.length; i++) {
        const char = cleanText[i];
        if (char === startChar) {
            balance++;
        } else if (char === endChar) {
            balance--;
        }
        if (balance === 0) {
            endIndex = i;
            break; 
        }
    }

    if (endIndex === -1) {
        throw new Error("Could not find a matching end delimiter for the JSON structure.");
    }

    const jsonString = cleanText.substring(startIndex, endIndex + 1);
    
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Failed to parse extracted JSON string:", { originalText: text, extracted: jsonString });
        throw error;
    }
};


// --- MAIN APP COMPONENT ---

const App = () => {
  const [appState, setAppState] = useState<'dashboard' | 'upload' | 'generating' | 'test' | 'analysis'>('dashboard');
  const [allTests, setAllTests] = useState<SavedTest[]>([]);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [sectionalFiles, setSectionalFiles] = useState<{ varc: File[], dilr: File[], qa: File[] }>({ varc: [], dilr: [], qa: [] });
  const [isDragging, setIsDragging] = useState(false);
  const [testTypeToGenerate, setTestTypeToGenerate] = useState<TestType>('Full Mock');
  const [showDriveHelp, setShowDriveHelp] = useState(false);
  const [testIdForDrive, setTestIdForDrive] = useState<string | null>(null);
  const [ai, setAi] = useState<GoogleGenAI | null>(null);
  const [isApiReady, setIsApiReady] = useState(false);

  const activeTest = useMemo(() => allTests.find(t => t.id === activeTestId), [allTests, activeTestId]);

  // Effect for one-time AI initialization
  useEffect(() => {
    const initializeAi = () => {
      let key = process.env.API_KEY;
      if (!key) {
          key = localStorage.getItem('cat-ai-api-key');
      }
      if (!key) {
          const userInput = window.prompt("Welcome! Please enter your Google AI API Key to proceed.");
          if (userInput) {
              localStorage.setItem('cat-ai-api-key', userInput);
              key = userInput;
          }
      }

      if (key) {
        try {
          const genAI = new GoogleGenAI({ apiKey: key });
          setAi(genAI);
          setIsApiReady(true);
        } catch (error) {
          console.error("Failed to initialize GoogleGenAI", error);
          alert("Failed to initialize AI. Please check your API key and refresh.");
          localStorage.removeItem('cat-ai-api-key');
          setIsApiReady(false);
        }
      } else {
        alert("A Google AI API Key is required to use this application.");
      }
    };
    initializeAi();
  }, []);

  // Load tests from localStorage on initial render
  useEffect(() => {
    try {
      const savedTests = localStorage.getItem('cat-ai-tests');
      if (savedTests) {
        setAllTests(JSON.parse(savedTests));
      }
    } catch (error) {
      console.error("Failed to load tests from localStorage", error);
      setAllTests([]);
    }
  }, []);

  // Save tests to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('cat-ai-tests', JSON.stringify(allTests));
    } catch (error) {
      console.error("Failed to save tests to localStorage", error);
    }
  }, [allTests]);

  const updateActiveTest = useCallback((updates: Partial<SavedTest>) => {
    setAllTests(prevTests =>
      prevTests.map(t => (t.id === activeTestId ? { ...t, ...updates } : t))
    );
  }, [activeTestId]);

  // --- NAVIGATION & STATE CHANGE HANDLERS ---
  
  const goToDashboard = () => {
    setActiveTestId(null);
    setSectionalFiles({ varc: [], dilr: [], qa: [] });
    setAppState('dashboard');
  };

  const startNewTestCreation = () => {
    setSectionalFiles({ varc: [], dilr: [], qa: [] });
    setTestTypeToGenerate('Full Mock');
    setAppState('upload');
  };

  const startTest = (testId: string) => {
    setActiveTestId(testId);
    setAppState('test');
  };

  const viewAnalysis = (testId: string) => {
    setActiveTestId(testId);
    setAppState('analysis');
  }

  const handleRetest = (testId: string) => {
    const originalTest = allTests.find(t => t.id === testId);
    if (!originalTest) return;

    const newTest: SavedTest = JSON.parse(JSON.stringify(originalTest));
    
    // Reset properties for a fresh attempt
    newTest.id = Date.now().toString();
    const originalName = originalTest.name.split(' (Retest')[0];
    const retestCount = allTests.filter(t => t.name.startsWith(originalName) && t.name.includes('Retest')).length;
    newTest.name = `${originalName} (Retest ${retestCount + 1})`;
    
    newTest.status = 'Not Started';
    delete newTest.finalScore;
    
    // Reset answers and timers
    const initialAnswers: UserAnswers = {};
    const initialTimers: Record<number, number> = {};
    newTest.testData.sections.forEach((section, sIdx) => {
        initialAnswers[sIdx] = {};
        initialTimers[sIdx] = section.timeLimit * 60;
        let qCounter = 0;
        section.items.forEach(item => {
            const questions = isPassageGroup(item) ? item.questions : [item];
            questions.forEach(() => {
                initialAnswers[sIdx][qCounter] = { answer: null, status: 'not-answered' };
                qCounter++;
            });
        });
    });

    newTest.userAnswers = initialAnswers;
    newTest.timers = initialTimers;
    newTest.lastActiveSection = 0;
    newTest.lockedSections = {};

    setAllTests(prev => [...prev, newTest]);
  };

  // --- FILE HANDLING ---
  
  const handleFileUpdate = (files: File[], sectionKey: SectionKey) => {
    setSectionalFiles(prev => ({...prev, [sectionKey]: files}));
  };
  
  const handleDragEvents = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      e.type === "dragover" ? setIsDragging(true) : setIsDragging(false);
  };
  
  // --- GOOGLE DRIVE SAVE ---

  const handleDownloadAndRedirect = (testId: string) => {
    const testToSave = allTests.find(t => t.id === testId);
    if (!testToSave) return;

    const dataStr = JSON.stringify(testToSave, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${testToSave.name.replace(/ /g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    setTimeout(() => {
        window.open('https://drive.google.com/drive/my-drive', '_blank');
    }, 500);
  };

  const handleSaveToDriveClick = (testId: string) => {
    const hasSeenDriveHelp = localStorage.getItem('hasSeenCatAiDriveHelp');
    if (hasSeenDriveHelp) {
        handleDownloadAndRedirect(testId);
    } else {
        setTestIdForDrive(testId);
        setShowDriveHelp(true);
    }
  };

  const onConfirmDriveSave = () => {
    if (testIdForDrive) {
        handleDownloadAndRedirect(testIdForDrive);
        localStorage.setItem('hasSeenCatAiDriveHelp', 'true');
    }
    setShowDriveHelp(false);
    setTestIdForDrive(null);
  };


  // --- TEST GENERATION ---

  const generateMockTest = useCallback(async () => {
    if (!ai) {
      alert("The AI client is not ready. Please ensure your API key is set correctly and refresh the page.");
      return;
    }
    setAppState('generating');
    
    const MAX_CONTENT_LENGTH = 500000;
    const sectionDetails: Record<SectionKey, { name: string; q: number; fullName: string }> = {
        'varc': { name: 'VARC', q: 24, fullName: 'Verbal Ability and Reading Comprehension (VARC)' },
        'dilr': { name: 'DILR', q: 20, fullName: 'Data Interpretation & Logical Reasoning (DILR)' },
        'qa': { name: 'QA', q: 22, fullName: 'Quantitative Ability (QA)' },
    };

    const getSectionPrompt = (sectionKey: SectionKey, content: string) => {
        const details = sectionDetails[sectionKey];
        const baseInstruction = `You are an expert CAT exam creator. Generate ONLY a single sectional test for '${details.fullName}'.

--- CAT 2025 CONTEXT ---
The CAT 2025 exam is expected to have 66 questions in 2 hours with a "Moderate" difficulty level, similar to CAT 2022/2024. The number of test-takers is projected to be around 300,000.
- For ${details.fullName}, adhere to these difficulty standards:
- VARC: Generally moderate difficulty. A 99th percentile score is typically 38-42 marks.
- DILR: This is consistently the most challenging, "gatekeeper" section. A 99th percentile score is lower, often 26-34 marks. Create complex, multi-layered reasoning sets. There should be 4 sets with 5 questions each.
- QA: This section has variable difficulty. For a moderate paper, the 99th percentile target is 30-33 marks. Include a mix of easy, moderate, and difficult questions.
--- END CONTEXT ---

The output MUST be a single, valid JSON object, without any markdown formatting.
The root object MUST contain a "sections" array with exactly ONE section object inside.
The section must have a 40-minute time limit, contain exactly ${details.q} questions, and be named "${details.fullName}".

Each question object MUST have this structure: { "questionText": "...", "type": "MCQ" or "TITA", "options": [...], "correctAnswer": "..." }.
- For "MCQ" questions, "options" must be an array of strings.
- For "TITA" (Type-In-The-Answer) questions, "options" MUST be an empty array []. TITA is common for QA and DILR.

For Reading Comprehension (VARC) or Logical Reasoning sets (DILR), group related questions under a single passage object: { "passage": "...", "questions": [...] }. Standalone questions should be single objects in the "items" array.
The JSON structure MUST be: { "sections": [{ "name": "${details.fullName}", "timeLimit": 40, "items": [ ... ] }] }`;
        
        return `${baseInstruction}\n\nDerive questions from the following content:\n\n--- CONTENT START ---\n${content}\n--- CONTENT END ---`;
    };

    const generateSection = async (sectionKey: SectionKey, fileList: File[]): Promise<Section> => {
        if (fileList.length === 0) throw new Error(`No files provided for the ${sectionDetails[sectionKey].name} section.`);

        const fileContents = await Promise.all(fileList.map(file => file.text().catch(() => "")));
        let combinedText = fileContents.join('\n\n---\n\n').trim();
        if (!combinedText) throw new Error(`Could not read content for the ${sectionDetails[sectionKey].name} section.`);
        
        if (combinedText.length > MAX_CONTENT_LENGTH) {
            combinedText = combinedText.substring(0, MAX_CONTENT_LENGTH);
        }

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: getSectionPrompt(sectionKey, combinedText),
        });

        const parsedData = parseJsonFromText(response.text);
        if (parsedData.sections && parsedData.sections.length > 0) {
            return parsedData.sections[0];
        }
        throw new Error(`AI failed to generate a valid section structure for ${sectionDetails[sectionKey].name}.`);
    };

    try {
        let testData: TestData;
        if (testTypeToGenerate === 'Full Mock') {
             const [varcSection, dilrSection, qaSection] = await Promise.all([
                generateSection('varc', sectionalFiles.varc),
                generateSection('dilr', sectionalFiles.dilr),
                generateSection('qa', sectionalFiles.qa),
            ]);
            testData = { sections: [varcSection, dilrSection, qaSection] };
        } else {
            const sectionKey = testTypeToGenerate.toLowerCase() as SectionKey;
            const section = await generateSection(sectionKey, sectionalFiles[sectionKey]);
            testData = { sections: [section] };
        }

        const initialAnswers: UserAnswers = {};
        const initialTimers: Record<number, number> = {};
        testData.sections.forEach((section, sIdx) => {
            initialAnswers[sIdx] = {};
            initialTimers[sIdx] = section.timeLimit * 60;
            let qCounter = 0;
            section.items.forEach(item => {
                const questions = isPassageGroup(item) ? item.questions : [item];
                questions.forEach(() => {
                    initialAnswers[sIdx][qCounter] = { answer: null, status: 'not-answered' };
                    qCounter++;
                });
            });
        });

        const getNewTestName = () => {
            const count = allTests.filter(t => t.type === testTypeToGenerate).length;
            return testTypeToGenerate === 'Full Mock' ? `FM${count + 1}` : `ST-${testTypeToGenerate}-${count + 1}`;
        };

        const newTest: SavedTest = {
            id: Date.now().toString(),
            name: getNewTestName(),
            type: testTypeToGenerate,
            status: 'Not Started',
            testData,
            userAnswers: initialAnswers,
            timers: initialTimers,
            lastActiveSection: 0,
            lockedSections: {}
        };

        setAllTests(prev => [...prev, newTest]);
        setActiveTestId(newTest.id);
        setAppState('test');

    } catch (error) {
        console.error("Error generating test:", error);
        alert(`Failed to generate the test. Error: ${error instanceof Error ? error.message : String(error)}. Please try again.`);
        setAppState('upload');
    }
  }, [sectionalFiles, ai, allTests, testTypeToGenerate]);

  // --- RENDER LOGIC ---

  const renderContent = () => {
    if (!isApiReady) {
      return (
        <div className="api-key-prompt-container">
          <h1>Welcome to CAT Mock Generator AI</h1>
          <p>Initializing... Please provide your Google AI API Key when prompted.</p>
          <p>If you did not see a prompt, please refresh the page. Your key will be saved in your browser's local storage for future visits.</p>
          <div className="spinner"></div>
        </div>
      );
    }
    
    switch (appState) {
      case 'dashboard':
        return <DashboardView tests={allTests} onStartTest={startTest} onNewTest={startNewTestCreation} onViewAnalysis={viewAnalysis} onRetest={handleRetest} onSaveToDrive={handleSaveToDriveClick} />;
      case 'upload':
        return <UploadView 
                  sectionalFiles={sectionalFiles}
                  isDragging={isDragging}
                  testType={testTypeToGenerate}
                  onFileUpdate={handleFileUpdate}
                  onDragEvents={handleDragEvents}
                  onGenerate={generateMockTest}
                  onSetTestType={setTestTypeToGenerate}
                  onBack={goToDashboard}
                />;
      case 'generating':
        return <LoadingView />;
      case 'test':
        return activeTest ? <TestView test={activeTest} onUpdate={updateActiveTest} onComplete={viewAnalysis} ai={ai} /> : <ErrorView onBack={goToDashboard} />;
      case 'analysis':
        return activeTest ? <AnalysisView test={activeTest} onBack={goToDashboard} ai={ai} /> : <ErrorView onBack={goToDashboard} />;
      default:
        return <ErrorView onBack={goToDashboard} />;
    }
  };

  return (
    <div className="app-container">
      {showDriveHelp && <DriveHelpModal onConfirm={onConfirmDriveSave} onCancel={() => setShowDriveHelp(false)} />}
      {renderContent()}
    </div>
  );
};

// --- CHILD COMPONENTS ---

const DashboardView = ({ tests, onStartTest, onNewTest, onViewAnalysis, onRetest, onSaveToDrive }: any) => (
  <div className="dashboard-container">
    <header className="dashboard-header">
      <h1>CAT Mock Dashboard</h1>
      <button className="btn primary" onClick={onNewTest}>+ Generate New Test</button>
    </header>
    <main className="test-list">
      {tests.length === 0 ? (
        <p className="no-tests-message">You haven't generated any tests yet. Click the button above to get started!</p>
      ) : (
        tests.map((test: SavedTest) => (
          <div className="test-card" key={test.id}>
            <div className="test-card-info">
              <span className={`status-badge ${test.status.replace(' ', '-').toLowerCase()}`}>{test.status}</span>
              <h3>{test.name}</h3>
              <p>{test.type}</p>
            </div>
            <div className="test-card-actions">
              {test.status === 'Completed' ? (
                <>
                  <button className="btn" onClick={() => onViewAnalysis(test.id)}>View Analysis</button>
                  <button className="btn secondary" onClick={() => onRetest(test.id)}>Retest</button>
                  <button className="btn tertiary" onClick={() => onSaveToDrive(test.id)}>Save to Drive</button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => onStartTest(test.id)}>{test.status === 'In Progress' ? 'Resume Test' : 'Start Test'}</button>
                  <button className="btn tertiary" onClick={() => onSaveToDrive(test.id)}>Save to Drive</button>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </main>
  </div>
);

const FileDropZoneComponent = ({ onFileUpdate, onDragEvents, files, sectionKey, label }: any) => {
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        onDragEvents(e); // Handles isDragging state
        if (e.dataTransfer.files?.length) {
            onFileUpdate(Array.from(e.dataTransfer.files), sectionKey);
            e.dataTransfer.clearData();
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            onFileUpdate(Array.from(e.target.files), sectionKey);
        }
    };

    return (
        <div className="file-drop-container">
            <p className="upload-label">{label}</p>
            <div 
                className="file-drop-zone single"
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={onDragEvents}
                onDragEnter={onDragEvents}
                onDragLeave={onDragEvents}
            >
                <input type="file" ref={fileInputRef} multiple onChange={handleFileChange} hidden />
                <p>Drop files or click</p>
            </div>
             {files.length > 0 && (
                <div className="file-list-item single-file">{files[0].name}{files.length > 1 ? ` & ${files.length-1} more` : ''}</div>
            )}
        </div>
    );
};

const UploadView = ({ sectionalFiles, isDragging, testType, onFileUpdate, onDragEvents, onGenerate, onSetTestType, onBack }: any) => {
    
    const isGenerateDisabled = () => {
        if (testType === 'Full Mock') {
            return sectionalFiles.varc.length === 0 || sectionalFiles.dilr.length === 0 || sectionalFiles.qa.length === 0;
        } else {
            const key = testType.toLowerCase() as SectionKey;
            return sectionalFiles[key].length === 0;
        }
    };
    
    return (
      <div className="upload-container">
         <button className="back-btn" onClick={onBack}>← Back to Dashboard</button>
        <h1>Create a New Mock Test</h1>
        <p>Choose test type, upload materials, and let the AI build your test.</p>

        <div className="upload-options">
          <p className="upload-label">1. Select Test Type</p>
          <div className="test-type-selector">
            {(['Full Mock', 'VARC', 'DILR', 'QA'] as TestType[]).map(type => (
              <label key={type} className={`radio-label ${testType === type ? 'selected' : ''}`}>
                <input type="radio" name="testType" value={type} checked={testType === type} onChange={() => onSetTestType(type)} />
                {type}
              </label>
            ))}
          </div>
        </div>
        
        <div className={`upload-options content-upload ${isDragging ? 'drag-over' : ''}`}>
           <p className="upload-label">2. Upload Content</p>
           {testType === 'Full Mock' ? (
               <div className="sectional-upload-grid">
                   <FileDropZoneComponent label="VARC Content" sectionKey="varc" files={sectionalFiles.varc} {...{ onFileUpdate, onDragEvents }} />
                   <FileDropZoneComponent label="DILR Content" sectionKey="dilr" files={sectionalFiles.dilr} {...{ onFileUpdate, onDragEvents }} />
                   <FileDropZoneComponent label="QA Content" sectionKey="qa" files={sectionalFiles.qa} {...{ onFileUpdate, onDragEvents }} />
               </div>
           ) : (
               <div className="single-upload">
                   <FileDropZoneComponent label={`${testType} Content`} sectionKey={testType.toLowerCase()} files={sectionalFiles[testType.toLowerCase()]} {...{ onFileUpdate, onDragEvents }} />
               </div>
           )}
           <p className="info-text">For best results (e.g., PDF, DOCX), convert to .txt first.</p>
        </div>

        <button className="btn" onClick={onGenerate} disabled={isGenerateDisabled()}>Generate Test</button>
      </div>
    );
};

const LoadingView = () => (
  <div className="loading-container">
    <div className="spinner"></div>
    <p>AI is building your custom mock test... This may take a moment.</p>
  </div>
);

const ErrorView = ({ onBack }: { onBack: () => void }) => (
    <div className="analysis-container">
        <h1>Error</h1>
        <p>Something went wrong, or the test could not be found.</p>
        <button className="btn" onClick={onBack}>Back to Dashboard</button>
    </div>
);

const ConfirmationModal = ({ onConfirm, onCancel }: { onConfirm: () => void, onCancel: () => void }) => (
  <div className="modal-overlay">
    <div className="modal-content">
      <h2>Confirm Submission</h2>
      <p>Are you sure you want to submit the test? You cannot make any more changes after this.</p>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={onConfirm}>Yes, Submit</button>
      </div>
    </div>
  </div>
);

const DriveHelpModal = ({ onConfirm, onCancel }: { onConfirm: () => void, onCancel: () => void }) => (
  <div className="modal-overlay">
    <div className="modal-content drive-help-modal">
      <h2>How to Save to Google Drive</h2>
      <ol className="drive-steps">
        <li>Your browser will download the test data as a <code>.json</code> file.</li>
        <li>A new browser tab will open to your Google Drive homepage.</li>
        <li>Simply <strong>drag and drop</strong> the downloaded file into the new Google Drive tab to upload it.</li>
      </ol>
      <p className="modal-info">This app doesn't ask for your Google password or permissions. You are in full control of your files.</p>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={onConfirm}>Got It, Continue</button>
      </div>
    </div>
  </div>
);

const SectionSwitchModal = ({ onConfirm, onCancel, remainingTime }: { onConfirm: () => void, onCancel: () => void, remainingTime: string }) => (
  <div className="modal-overlay">
    <div className="modal-content">
      <h2>Confirm Section Switch</h2>
      <p>You have <strong>{remainingTime}</strong> left in this section.</p>
      <p className="modal-warning-text">Once you leave this section, you will not be able to return. Are you sure you want to continue?</p>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={onConfirm}>Switch Section</button>
      </div>
    </div>
  </div>
);

type FlattenedQuestion = {
    question: Question;
    passage?: string;
    originalIndex: number;
    status: AnswerStatus;
    answer: string | null;
}

const TestView = ({ test, onUpdate, onComplete, ai }: { test: SavedTest, onUpdate: (updates: Partial<SavedTest>) => void, onComplete: (id: string) => void, ai: GoogleGenAI | null }) => {
    const [currentSectionIndex, setCurrentSectionIndex] = useState(test.lastActiveSection);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [timers, setTimers] = useState(test.timers);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [showSectionSwitchConfirm, setShowSectionSwitchConfirm] = useState<{ show: boolean, targetIndex: number | null }>({ show: false, targetIndex: null });
    
    // Flatten questions for the current section to simplify navigation and rendering
    const questionsForCurrentSection: FlattenedQuestion[] = useMemo(() => {
        if (!test.testData.sections[currentSectionIndex]) return [];
        let flattened: FlattenedQuestion[] = [];
        let qCounter = 0;
        test.testData.sections[currentSectionIndex].items.forEach(item => {
            if (isPassageGroup(item)) {
                item.questions.forEach(q => {
                    const userAnswer = test.userAnswers[currentSectionIndex]?.[qCounter] || {answer: null, status: 'not-answered'};
                    flattened.push({ question: q, passage: item.passage, originalIndex: qCounter, status: userAnswer.status, answer: userAnswer.answer });
                    qCounter++;
                });
            } else {
                const userAnswer = test.userAnswers[currentSectionIndex]?.[qCounter] || {answer: null, status: 'not-answered'};
                flattened.push({ question: item, originalIndex: qCounter, status: userAnswer.status, answer: userAnswer.answer });
                qCounter++;
            }
        });
        return flattened;
    }, [test.testData, currentSectionIndex, test.userAnswers]);

    const confirmAndSubmit = useCallback(() => {
        setShowConfirmModal(false);
        let totalCorrect = 0, totalIncorrect = 0, totalAttempted = 0;
        
        test.testData.sections.forEach((section, sIdx) => {
            let qCounter = 0;
            section.items.forEach(item => {
                const questions = isPassageGroup(item) ? item.questions : [item];
                questions.forEach(q => {
                    const userAnswer = test.userAnswers[sIdx]?.[qCounter];
                    if (userAnswer && userAnswer.answer !== null && userAnswer.answer !== '') {
                        totalAttempted++;
                        if (q.type === 'MCQ' && userAnswer.answer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim()) {
                            totalCorrect++;
                        } else if (q.type === 'TITA' && parseFloat(userAnswer.answer) === parseFloat(q.correctAnswer)) {
                             totalCorrect++;
                        }
                        else {
                            totalIncorrect++;
                        }
                    }
                    qCounter++;
                });
            });
        });

        const score = (totalCorrect * 3) - (test.type === 'Full Mock' ? totalIncorrect : 0);
        const allLocked = test.testData.sections.reduce((acc, _, idx) => ({...acc, [idx]: true}), {});
        onUpdate({ 
            finalScore: { score, correct: totalCorrect, incorrect: totalIncorrect, attempted: totalAttempted },
            status: 'Completed',
            timers,
            lockedSections: allLocked
        });
        onComplete(test.id);
    }, [test, onUpdate, onComplete, timers]);

    useEffect(() => {
        const timerInterval = setInterval(() => {
            setTimers(prev => {
                const newTimers = { ...prev };
                if (newTimers[currentSectionIndex] > 0 && !test.lockedSections?.[currentSectionIndex]) {
                    newTimers[currentSectionIndex]--;
                }
                
                if (newTimers[currentSectionIndex] <= 0 && !test.lockedSections?.[currentSectionIndex]) {
                    const newLocked = { ...(test.lockedSections || {}), [currentSectionIndex]: true };
                    const nextSectionIndex = test.testData.sections.findIndex((_, idx) => idx > currentSectionIndex && !newLocked[idx]);
    
                    if (nextSectionIndex !== -1) {
                         onUpdate({ lockedSections: newLocked, lastActiveSection: nextSectionIndex });
                         setCurrentSectionIndex(nextSectionIndex);
                         setCurrentQuestionIndex(0);
                    } else {
                        confirmAndSubmit();
                    }
                }
                return newTimers;
            });
        }, 1000);
        return () => clearInterval(timerInterval);
    }, [currentSectionIndex, test.lockedSections, test.testData.sections, onUpdate, confirmAndSubmit]);
    
    useEffect(() => {
        const persistInterval = setInterval(() => onUpdate({ timers }), 5000);
        return () => clearInterval(persistInterval);
    }, [timers, onUpdate]);

    const handleAnswerUpdate = (originalIndex: number, newAnswer: string | null, newStatus: AnswerStatus) => {
        const newAnswers = JSON.parse(JSON.stringify(test.userAnswers));
        newAnswers[currentSectionIndex][originalIndex] = { answer: newAnswer, status: newStatus };
        onUpdate({ userAnswers: newAnswers, status: 'In Progress' });
    };

    const handleSelectOption = (option: string) => {
        const q = questionsForCurrentSection[currentQuestionIndex];
        handleAnswerUpdate(q.originalIndex, option, q.status === 'not-answered' ? 'answered' : q.status);
    };

    const handleTitaInputChange = (value: string) => {
        const q = questionsForCurrentSection[currentQuestionIndex];
        const newStatus = value ? (q.status === 'not-answered' ? 'answered' : q.status) : 'not-answered';
        handleAnswerUpdate(q.originalIndex, value.trim() || null, newStatus);
    };

    const handleSaveAndNext = () => {
        const q = questionsForCurrentSection[currentQuestionIndex];
        if (q.answer && q.status !== 'answered') {
           handleAnswerUpdate(q.originalIndex, q.answer, 'answered');
        }
        if (currentQuestionIndex < questionsForCurrentSection.length - 1) {
            setCurrentQuestionIndex(i => i + 1);
        } else {
            alert("You are at the last question of this section.");
        }
    };

    const handleMarkForReview = () => {
        const q = questionsForCurrentSection[currentQuestionIndex];
        handleAnswerUpdate(q.originalIndex, q.answer, 'marked');
        if (currentQuestionIndex < questionsForCurrentSection.length - 1) {
            setCurrentQuestionIndex(i => i + 1);
        }
    };
    
    const handleClearResponse = () => {
        const q = questionsForCurrentSection[currentQuestionIndex];
        handleAnswerUpdate(q.originalIndex, null, 'not-answered');
    };

    const handleSubmitTest = () => setShowConfirmModal(true);
    
    const handleConfirmSectionSwitch = (targetIndex: number) => {
        const newLockedSections = { ...(test.lockedSections || {}), [currentSectionIndex]: true };
        onUpdate({ lastActiveSection: targetIndex, lockedSections: newLockedSections, timers });
        setCurrentSectionIndex(targetIndex);
        setCurrentQuestionIndex(0);
        setShowSectionSwitchConfirm({ show: false, targetIndex: null });
    };

    const changeSection = (index: number) => {
        if (index === currentSectionIndex || test.lockedSections?.[index]) return;

        if (timers[currentSectionIndex] > 0) {
            setShowSectionSwitchConfirm({ show: true, targetIndex: index });
        } else {
            handleConfirmSectionSwitch(index);
        }
    };
  
    const formatTime = (seconds: number) => `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;

    const currentQuestionData = questionsForCurrentSection[currentQuestionIndex];
    if (!currentQuestionData) {
        if (test.status === 'Completed') {
            return <AnalysisView test={test} onBack={() => onComplete(test.id)} ai={ai} />;
        }
        return <LoadingView />;
    }

    return (
        <div className="test-screen">
            {showConfirmModal && <ConfirmationModal onConfirm={confirmAndSubmit} onCancel={() => setShowConfirmModal(false)} />}
            {showSectionSwitchConfirm.show && <SectionSwitchModal onConfirm={() => handleConfirmSectionSwitch(showSectionSwitchConfirm.targetIndex!)} onCancel={() => setShowSectionSwitchConfirm({show: false, targetIndex: null})} remainingTime={formatTime(timers[currentSectionIndex])} />}
            
            <header className="test-header">
                <h1>{test.name}</h1>
                <div className="timer">{formatTime(timers[currentSectionIndex] || 0)}</div>
                <button className="btn secondary" onClick={handleSubmitTest}>Submit Test</button>
            </header>

            <div className="section-tabs">
                {test.testData.sections.map((section, index) => (
                    <button 
                        key={index} 
                        onClick={() => changeSection(index)}
                        disabled={test.lockedSections?.[index]}
                        className={`section-tab ${index === currentSectionIndex ? 'active' : ''} ${test.lockedSections?.[index] ? 'locked' : ''}`}
                    >
                        {section.name.split('(')[0].trim()}
                    </button>
                ))}
            </div>

            <main className={`question-panel ${currentQuestionData.passage ? 'with-passage' : ''}`}>
                {currentQuestionData.passage && (
                    <div className="passage-viewer">
                        <h3>Passage</h3>
                        <div className="passage-content">{currentQuestionData.passage}</div>
                    </div>
                )}
                <div className="question-content-area">
                    <p className="question-text">Q{currentQuestionIndex + 1}: {currentQuestionData.question.questionText}</p>
                    {currentQuestionData.question.type === 'MCQ' ? (
                        <ul className="options-list">
                            {currentQuestionData.question.options.map((opt, i) => (
                                <li key={i} className={`option-item ${currentQuestionData.answer === opt ? 'selected' : ''}`} onClick={() => handleSelectOption(opt)}>
                                    <input type="radio" name={`q_${currentQuestionIndex}`} readOnly checked={currentQuestionData.answer === opt} />
                                    <label>{opt}</label>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="tita-answer-area">
                             <input 
                                type="text"
                                className="tita-input"
                                placeholder="Enter your answer"
                                value={currentQuestionData.answer || ''}
                                onChange={(e) => handleTitaInputChange(e.target.value)}
                            />
                        </div>
                    )}
                </div>
            </main>

            <aside className="question-palette">
                <div className="palette-grid">
                    {questionsForCurrentSection.map((q, index) => (
                        <button 
                          key={index}
                          onClick={() => setCurrentQuestionIndex(index)} 
                          className={`palette-btn ${q.status} ${index === currentQuestionIndex ? 'current' : ''}`}
                        >
                            {index + 1}
                        </button>
                    ))}
                </div>
                 <div className="palette-legend">
                    <div className="legend-item"><span className="legend-color answered"></span> Answered</div>
                    <div className="legend-item"><span className="legend-color marked"></span> Marked</div>
                    <div className="legend-item"><span className="legend-color not-answered"></span> Not Answered</div>
                </div>
            </aside>

            <footer className="test-footer">
                <div>
                    <button className="footer-btn purple" onClick={handleMarkForReview}>Mark for Review & Next</button>
                    <button className="footer-btn" onClick={handleClearResponse}>Clear Response</button>
                </div>
                <button className="footer-btn primary" onClick={handleSaveAndNext}>Save & Next</button>
            </footer>
        </div>
    );
};

// --- ANALYSIS COMPONENTS ---

const AnalysisView = ({ test, onBack, ai }: { test: SavedTest, onBack: () => void, ai: GoogleGenAI | null }) => {
    const [analysisData, setAnalysisData] = useState<Record<string, Record<string, AIAnalysisData>>>({});
    const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<Record<string, string | null>>({});

    const fetchAllAnalysesForSection = useCallback(async (sectionIndex: number) => {
        if (!ai || isLoading[sectionIndex] || analysisData[sectionIndex]) {
            return;
        }

        setIsLoading(prev => ({ ...prev, [sectionIndex]: true }));
        setError(prev => ({ ...prev, [sectionIndex]: null }));

        const section = test.testData.sections[sectionIndex];
        const questionsForPrompt = section.items.map((item) => {
            const questions = isPassageGroup(item) ? item.questions : [item];
            return questions.map((q) => ({
                 questionText: q.questionText,
                 options: q.options,
                 correctAnswer: q.correctAnswer,
                 passage: isPassageGroup(item) ? item.passage : undefined
             }));
        }).flat();
        
        const prompt = `You are an expert CAT exam analyst. Analyze the following list of questions from a test.
For EACH question, provide a detailed step-by-step explanation for the correct answer and a difficulty rating (Easy, Medium, or Hard).
The output MUST be a single, valid JSON array of analysis objects. DO NOT include any text outside the JSON array.
The output array MUST have the same number of objects as the input array and be in the same order.
Each object in the output array MUST have this exact structure: { "explanation": "...", "difficulty": "..." }.
Here are the questions to analyze:
${JSON.stringify(questionsForPrompt)}`;

        try {
            const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
            const parsedResults = parseJsonFromText(response.text);

            if (!Array.isArray(parsedResults) || parsedResults.length !== questionsForPrompt.length) {
                throw new Error("AI response was not a valid array or had a mismatched length.");
            }

            const newSectionAnalysis: Record<string, AIAnalysisData> = {};
            parsedResults.forEach((result, index) => {
                newSectionAnalysis[index] = {
                    explanation: result.explanation || "No explanation provided.",
                    difficulty: result.difficulty || "Medium"
                };
            });

            setAnalysisData(prev => ({ ...prev, [sectionIndex]: newSectionAnalysis }));
        } catch (e) {
            console.error("Error fetching batch analysis:", e);
            setError(prev => ({...prev, [sectionIndex]: `Failed to get AI analysis. ${e instanceof Error ? e.message : ''}`}));
        } finally {
            setIsLoading(prev => ({ ...prev, [sectionIndex]: false }));
        }
    }, [ai, test.testData.sections, analysisData, isLoading]);

    useEffect(() => {
        if (!ai) {
            test.testData.sections.forEach((_, sIdx) => {
                setError(prev => ({...prev, [sIdx]: 'AI Client not initialized. Cannot fetch analysis.'}));
            });
            return;
        }
        test.testData.sections.forEach((_, sIdx) => {
            fetchAllAnalysesForSection(sIdx);
        });
    }, [test.testData.sections, fetchAllAnalysesForSection, ai]);

    if (!test.finalScore) {
        return (
            <div className="analysis-container">
                <header className="analysis-header">
                     <h1>Analysis Not Available</h1>
                     <button className="btn" onClick={onBack}>Back to Dashboard</button>
                </header>
                <p style={{padding: '2rem', textAlign: 'center'}}>The test was not completed, so analysis cannot be shown.</p>
            </div>
        );
    }

    const { score, correct, incorrect, attempted } = test.finalScore;
    const { percentile, rank } = getProjectedRank(score);
    
    return (
        <div className="analysis-container">
            <header className="analysis-header">
                <h1>{test.name} - Analysis Report</h1>
                <button className="btn" onClick={onBack}>Back to Dashboard</button>
            </header>
            
            <div className="score-summary">
                <div className="summary-item">
                    <span className="value">{score}</span>
                    <span className="label">Total Score</span>
                </div>
                <div className="summary-item">
                    <span className="value">{rank}</span>
                    <span className="label">Projected Rank</span>
                </div>
                <div className="summary-item">
                    <span className="value">{percentile}%</span>
                    <span className="label">Projected Percentile</span>
                </div>
                <div className="summary-item">
                    <span className="value" style={{color: 'var(--green)'}}>{correct}</span>
                    <span className="label">Correct</span>
                </div>
                <div className="summary-item">
                    <span className="value" style={{color: 'var(--red)'}}>{incorrect}</span>
                    <span className="label">Incorrect</span>
                </div>
                 <div className="summary-item">
                    <span className="value">{attempted}</span>
                    <span className="label">Attempted</span>
                </div>
            </div>

            <div className="detailed-analysis">
                {test.testData.sections.map((section, sIdx) => {
                    let globalQuestionIndex = -1;
                    return (
                        <section key={sIdx} className="analysis-section">
                            <h2>{section.name}</h2>
                            {isLoading[sIdx] && <div className="loading-container" style={{height: '100px'}}><div className="spinner"></div></div>}
                            {error[sIdx] && <p className="error-message">{error[sIdx]}</p>}
                            <div className="questions-list">
                                {section.items.map((item, itemIdx) => {
                                    if (isPassageGroup(item)) {
                                        return (
                                            <div key={itemIdx} className="analysis-passage-group">
                                                <div className="passage-text-container">
                                                    <h3>Passage</h3>
                                                    <p>{item.passage}</p>
                                                </div>
                                                {item.questions.map((q) => {
                                                    globalQuestionIndex++;
                                                    return <QuestionAnalysisCard key={globalQuestionIndex} question={q} userAnswer={test.userAnswers[sIdx]?.[globalQuestionIndex]} analysis={analysisData[sIdx]?.[globalQuestionIndex]} questionNumber={globalQuestionIndex + 1} />
                                                })}
                                            </div>
                                        );
                                    } else {
                                        globalQuestionIndex++;
                                        return <QuestionAnalysisCard key={globalQuestionIndex} question={item} userAnswer={test.userAnswers[sIdx]?.[globalQuestionIndex]} analysis={analysisData[sIdx]?.[globalQuestionIndex]} questionNumber={globalQuestionIndex + 1} />
                                    }
                                })}
                            </div>
                        </section>
                    )
                })}
            </div>
        </div>
    );
};

const QuestionAnalysisCard = ({ question, userAnswer, analysis, questionNumber }: { question: Question, userAnswer: UserAnswer, analysis?: AIAnalysisData, questionNumber: number }) => {
    const isCorrect = userAnswer?.answer !== null && userAnswer?.answer?.toLowerCase().trim() === question.correctAnswer.toLowerCase().trim();
    const isUnattempted = userAnswer?.answer === null || userAnswer?.answer === '';
    
    let marksText = '0';
    let marksClass = 'marks-unattempted';
    if (!isUnattempted) {
        if (isCorrect) {
            marksText = '+3';
            marksClass = 'marks-correct';
        } else {
            marksText = '-1';
            marksClass = 'marks-incorrect';
        }
    }

    const difficulty = analysis?.difficulty?.toLowerCase() || 'medium';
    const difficultyClass = ['easy', 'medium', 'hard'].includes(difficulty) ? `difficulty-${difficulty}` : 'difficulty-medium';

    return (
        <div className="analysis-question-card">
            <div className="analysis-question-header">
                <p className="question-text"><strong>Q{questionNumber}:</strong> {question.questionText}</p>
                 <div className="header-meta">
                     {analysis?.difficulty ? (
                        <span className={`difficulty-badge ${difficultyClass}`}>{analysis.difficulty}</span>
                    ) : <span className="difficulty-badge" style={{backgroundColor: 'var(--border-color)'}}>...</span> }
                    <span className={`question-marks ${marksClass}`}>{marksText}</span>
                </div>
            </div>
            
            <div className="answer-section">
                <div className={`answer-box correct`}>
                    <strong>Correct Answer:</strong> {question.correctAnswer}
                </div>
                <div className={`answer-box ${isUnattempted ? '' : (isCorrect ? 'correct' : 'incorrect')}`}>
                    <strong>Your Answer:</strong>
                    {isUnattempted ? <span className="not-answered-text">Not Answered</span> : ` ${userAnswer.answer}`}
                </div>
            </div>

            {!analysis ? (
                <div className="explanation-loading">AI analysis is loading...</div>
            ) : (
                <div className="explanation-content">
                    <strong>Explanation:</strong>
                    <p>{analysis.explanation}</p>
                </div>
            )}
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);