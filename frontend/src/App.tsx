import { useEffect, useState } from 'react';
import { useBookStore } from './stores/useBookStore';
import BookList from './components/BookList';
import Reader from './components/Reader';
import SettingsPage from './components/SettingsPage';
import { BookOpen, Home, Menu, Settings, X } from 'lucide-react';
import { ToastProvider } from './contexts/ToastContext';
import { ToastContainer } from './components/Toast';
import './App.css';

type View = 'home' | 'reader' | 'settings';

function App() {
  const [view, setView] = useState<View>('home');
  const [showNavbar, setShowNavbar] = useState(true);
  const { currentBook, setCurrentBook } = useBookStore();

  useEffect(() => {
    if (currentBook) {
      setView('reader');
    }
  }, [currentBook]);

  // Add keyboard shortcut to toggle navbar (Ctrl+Shift+N)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        setShowNavbar(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNavigateHome = () => {
    setCurrentBook(null);
    setView('home');
  };

  const handleNavigateSettings = () => {
    setView('settings');
  };

  // In reader view, hide App navbar and let Reader manage its own header
  const showAppNavbar = showNavbar && view !== 'reader';

  return (
    <ToastProvider>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Navigation - only show in non-reader views */}
        {showAppNavbar && (
          <nav className="app-navbar relative overflow-hidden bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <div className="relative z-10 px-6 py-4">
              <div className="flex items-center justify-between">
                <h1 className="flex items-center gap-3 text-xl font-bold text-gray-900 dark:text-white">
                  <img
                    src="/foliopaw-icon.png"
                    alt=""
                    aria-hidden="true"
                    className="app-brand-icon"
                  />
                  <span>FolioPaw 阅读猫</span>
                </h1>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={handleNavigateHome}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${view === 'home'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                  >
                    <Home size={20} />
                    首页
                  </button>
                  {currentBook && (
                    <button
                      onClick={() => setView('reader')}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                    >
                      <BookOpen size={20} />
                      阅读
                    </button>
                  )}

                  <button
                    onClick={handleNavigateSettings}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${view === 'settings'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                  >
                    <Settings size={20} />
                    设置
                  </button>

                  <button
                    onClick={() => setShowNavbar(false)}
                    className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300 ml-2"
                    title="隐藏导航栏（按 Ctrl+Shift+N 显示）"
                    aria-label="隐藏导航栏"
                  >
                    <X size={20} />
                  </button>
                </div>
              </div>
            </div>
          </nav>
        )}

        {/* Show navbar button - appears when navbar is hidden (non-reader views only) */}
        {!showAppNavbar && view !== 'reader' && (
          <button
            onClick={() => setShowNavbar(true)}
            className="fixed top-4 left-4 z-50 p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg transition-all"
            title="显示导航栏（按 Ctrl+Shift+N 切换）"
            aria-label="显示导航栏"
          >
            <Menu size={24} />
          </button>
        )}

        {/* Main content */}
        <main>
          {view === 'home' && <BookList />}
          {view === 'reader' && (
            <Reader
              onNavigateHome={handleNavigateHome}
              onNavigateSettings={handleNavigateSettings}
            />
          )}
          {view === 'settings' && <SettingsPage />}
        </main>

        {/* Toast notifications */}
        <ToastContainer />
      </div>
    </ToastProvider>
  );
}

export default App;
