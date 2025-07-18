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
type AppTheme = 'light' | 'dark';

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
    } catch (e) {
        console.error("Failed to parse JSON string:", jsonString);
        throw new Error("Final string is not valid JSON.");
    }
};

// --- UI COMPONENTS ---

const ApiKeyPrompt = ({ onApiKeySubmit, error }: { onApiKeySubmit: (key: string) => void; error: string | null; }) => {
    const [apiKey, setApiKey] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (apiKey.trim()) {
            onApiKeySubmit(apiKey.trim());
        }
    };

    return (
        <div className="api-key-prompt-container">
            <div className="api-key-box">
                <h1>API Key Required</h1>
                <p>Please enter your Google Gemini API key to use the app. Your key will be stored locally in your browser.</p>
                <form onSubmit={handleSubmit}>
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="Enter your API Key"
                        aria-label="API Key Input"
                        className="api-key-input"
                    />
                    <button type="submit" className="btn primary" disabled={!apiKey.trim()}>
                        Continue
                    </button>
                </form>
                {error && <p className="error-message-prompt">{error}</p>}
                 <div className="api-key-info">
                    <p>You can get your API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</p>
                </div>
            </div>
        </div>
    );
};

const UploadScreen = ({ onBack, onGenerate }: { onBack: () => void, onGenerate: () => void }) => (
    <div className="upload-container">
        <button className="back-btn" onClick={onBack}>&larr; Dashboard</button>
        <h1>Create New Mock Test</h1>
        <p>Select the test type and upload your source material as .txt files.</p>
        <button className="btn primary" onClick={onGenerate}>Generate Test</button>
    </div>
);

const LoadingScreen = ({ message }: { message: string }) => (
    <div className="loading-container">
        <div className="spinner"></div>
        <p>{message}</p>
    </div>
);

const TestScreen = ({ onEndTest }: { onEndTest: () => void }) => (
    <div className="test-screen">
        <div className="test-header"><h1>Test In Progress</h1></div>
        <div className="question-panel"><p>Question content would appear here.</p></div>
        <div className="question-palette"><p>Palette</p></div>
        <div className="test-footer">
            <button className="btn primary" onClick={onEndTest}>Submit Test</button>
        </div>
    </div>
);

const AnalysisScreen = ({ onBackToDashboard }: { onBackToDashboard: () => void }) => (
     <div className="analysis-container">
        <div className="analysis-header">
            <h1>Test Analysis</h1>
            <button className="btn secondary" onClick={onBackToDashboard}>Back to Dashboard</button>
        </div>
        <div className="detailed-analysis">
            <p>Detailed analysis would be displayed here.</p>
        </div>
     </div>
);

const ThemeToggle = ({ theme, onToggle }: { theme: AppTheme, onToggle: () => void }) => {
  return (
    <button 
      className="theme-toggle" 
      onClick={onToggle} 
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      <div className="theme-toggle-track">
        <div className="theme-toggle-thumb">
          {theme === 'dark' ? '🌙' : '☀️'}
        </div>
      </div>
    </button>
  );
};

const DashboardScreen = ({ savedTests, onStartTest, onCreateTest, onDeleteTest, onViewAnalysis, theme, onToggleTheme }: {
    savedTests: SavedTest[],
    onStartTest: (id: string) => void,
    onCreateTest: () => void,
    onDeleteTest: (id: string) => void,
    onViewAnalysis: (id: string) => void,
    theme: AppTheme,
    onToggleTheme: () => void,
}) => {
    return (
        <div className="dashboard-container">
            <div className="dashboard-header">
                <h1>CAT Mock Generator AI</h1>
                <div className="dashboard-header-actions">
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                    <button className="btn primary" onClick={onCreateTest}>+ Create New Test</button>
                </div>
            </div>

            {savedTests.length > 0 ? (
                <div className="test-list">
                    {savedTests.map(test => (
                        <div key={test.id} className="test-card">
                            <div className="test-card-info">
                                <div>
                                    <h3>{test.name}</h3>
                                    <p>{test.type}</p>
                                </div>
                                <span className={`status-badge ${test.status.toLowerCase().replace(' ', '-')}`}>{test.status}</span>
                            </div>
                            <div className="test-card-actions">
                                <button className="btn tertiary" onClick={() => onViewAnalysis(test.id)}>Analysis</button>
                                <button className="btn primary" onClick={() => onStartTest(test.id)}>
                                    {test.status === 'In Progress' ? 'Resume' : 'Start'}
                                </button>
                                <button className="btn secondary" onClick={() => onDeleteTest(test.id)}>Delete</button>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="no-tests-message">
                    <p>No mock tests found.</p>
                    <p>Click "+ Create New Test" to get started!</p>
                </div>
            )}
        </div>
    );
};

// --- MAIN APP COMPONENT ---

const App = () => {
  type Screen = 'dashboard' | 'upload' | 'loading' | 'test' | 'analysis' | 'api_prompt';

  const [ai, setAi] = useState<GoogleGenAI | null>(null);
  const [currentScreen, setCurrentScreen] = useState<Screen>('loading');
  const [loadingMessage, setLoadingMessage] = useState('Initializing...');
  const [savedTests, setSavedTests] = useState<SavedTest[]>([]);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  
  const [theme, setTheme] = useState<AppTheme>(() => (localStorage.getItem('appTheme') as AppTheme || 'dark'));

  useEffect(() => {
    localStorage.setItem('appTheme', theme);
    document.body.className = `${theme}-mode`;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(currentTheme => currentTheme === 'dark' ? 'light' : 'dark');
  }, []);

  useEffect(() => {
    const storedApiKey = localStorage.getItem('gemini_api_key');
    if (storedApiKey) {
      try {
        const genAI = new GoogleGenAI({ apiKey: storedApiKey });
        setAi(genAI);
        setCurrentScreen('dashboard');
      } catch (error) {
        console.error("Failed to initialize with stored API key:", error);
        localStorage.removeItem('gemini_api_key');
        setApiKeyError("The stored API key is invalid. Please enter a new one.");
        setCurrentScreen('api_prompt');
      }
    } else {
      setCurrentScreen('api_prompt');
    }
  }, []);
  
  const handleApiKeySubmit = (key: string) => {
    try {
      const genAI = new GoogleGenAI({ apiKey: key });
      // The constructor doesn't throw an error for a syntactically valid but incorrect key.
      // A true validation would require an API call. For this app's purpose, we'll proceed
      // and let the user discover an invalid key upon first use.
      setAi(genAI);
      localStorage.setItem('gemini_api_key', key);
      setApiKeyError(null);
      setCurrentScreen('dashboard');
    } catch (error) {
      console.error("API Key initialization failed:", error);
      setApiKeyError("There was a problem with the API Key. Please check the console.");
    }
  };

  const startTest = (id: string) => {
    setActiveTestId(id);
    setCurrentScreen('test');
  };
  const createTest = () => setCurrentScreen('upload');
  const deleteTest = (id: string) => alert(`Test ${id} deleted.`);
  const viewAnalysis = (id: string) => {
    setActiveTestId(id);
    setCurrentScreen('analysis');
  };
  const generateTest = () => {
    setLoadingMessage('Generating test...');
    setCurrentScreen('loading');
    setTimeout(() => setCurrentScreen('dashboard'), 2000); // Simulate generation
  };


  const renderContent = () => {
    switch (currentScreen) {
      case 'api_prompt':
        return <ApiKeyPrompt onApiKeySubmit={handleApiKeySubmit} error={apiKeyError} />;
      case 'dashboard':
        return <DashboardScreen 
                    savedTests={savedTests} 
                    onStartTest={startTest} 
                    onCreateTest={createTest}
                    onDeleteTest={deleteTest}
                    onViewAnalysis={viewAnalysis}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                />;
      case 'upload':
        return <UploadScreen onBack={() => setCurrentScreen('dashboard')} onGenerate={generateTest} />;
      case 'loading':
        return <LoadingScreen message={loadingMessage} />;
      case 'test':
        return <TestScreen onEndTest={() => viewAnalysis(activeTestId!)} />;
      case 'analysis':
        return <AnalysisScreen onBackToDashboard={() => setCurrentScreen('dashboard')} />;
      default:
        return <p>Something went wrong.</p>;
    }
  };

  return (
    <div className="app-container">
      {renderContent()}
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  console.error('Failed to find the root element');
}