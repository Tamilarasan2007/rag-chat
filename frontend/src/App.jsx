import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

// The FastAPI backend URL.
// Vite exposes variables prefixed with VITE_ from .env files.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'

const STORAGE_KEY = 'rag_conversations'
const ACTIVE_CHAT_KEY = 'rag_active_chat_id'

function generateId() {
  return 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
}

function createNewConversation() {
  return {
    id: generateId(),
    title: 'New Chat',
    createdAt: Date.now(),
    messages: []
  }
}

function App() {
  // ── Conversation State & LocalStorage ──────────────────────────────────────
  const [conversations, setConversations] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
        }
      }
    } catch {
      // Ignore parse error and fallback
    }
    return [createNewConversation()]
  })

  const [activeId, setActiveId] = useState(() => {
    try {
      const savedActive = localStorage.getItem(ACTIVE_CHAT_KEY)
      if (savedActive) return savedActive
    } catch {
      // Ignore storage error
    }
    return ''
  })

  // Determine active conversation reliably without extra renders
  const activeConversation =
    conversations.find(c => c.id === activeId) || conversations[0] || createNewConversation()
  const currentChatId = activeConversation.id
  const messages = activeConversation.messages || []

  // Save conversations to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
    } catch {
      // LocalStorage might be full or disabled
    }
  }, [conversations])

  // Save activeId to localStorage whenever it changes
  useEffect(() => {
    if (currentChatId) {
      try {
        localStorage.setItem(ACTIVE_CHAT_KEY, currentChatId)
      } catch {
        // LocalStorage might be full or disabled
      }
    }
  }, [currentChatId])

  // ── UI States ─────────────────────────────────────────────────────────────
  const [question, setQuestion] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Checking...')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  // Ref to the bottom of the chat so we can scroll there automatically
  const chatEndRef = useRef(null)

  // Check backend health on page load and periodically
  useEffect(() => {
    let isMounted = true

    async function checkHealth() {
      try {
        const response = await fetch(`${BACKEND_URL}/api/health`)
        if (!response.ok) throw new Error('Backend returned an error.')
        const data = await response.json()
        if (isMounted) {
          setIsConnected(Boolean(data.rag_ready))
          setStatusMessage(data.rag_ready ? 'Connected' : 'Not Ready')
        }
      } catch {
        if (isMounted) {
          setIsConnected(false)
          setStatusMessage('Disconnected')
        }
      }
    }

    checkHealth()
    const interval = setInterval(checkHealth, 30000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [])

  // Auto-scroll to the bottom whenever messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isLoading])

  // ── Conversation Actions ──────────────────────────────────────────────────
  function handleNewChat() {
    if (activeConversation && messages.length === 0) {
      setIsSidebarOpen(false)
      return
    }

    const newChat = createNewConversation()
    setConversations(prev => [newChat, ...prev])
    setActiveId(newChat.id)
    setQuestion('')
    setIsSidebarOpen(false)
  }

  function handleSelectConversation(id) {
    setActiveId(id)
    setQuestion('')
    setIsSidebarOpen(false)
  }

  function handleClearChat() {
    if (messages.length === 0) return
    if (!window.confirm('Clear all messages in this conversation?')) return

    setConversations(prev =>
      prev.map(conv =>
        conv.id === currentChatId
          ? { ...conv, messages: [], title: 'New Chat' }
          : conv
      )
    )
  }

  function handleDeleteConversation(id, event) {
    event.stopPropagation()
    if (conversations.length <= 1) {
      const fresh = createNewConversation()
      setConversations([fresh])
      setActiveId(fresh.id)
      return
    }

    const remaining = conversations.filter(c => c.id !== id)
    setConversations(remaining)
    if (activeId === id) {
      setActiveId(remaining[0].id)
    }
  }

  // ── Send question to the backend ───────────────────────────────────────────
  async function sendQuestion() {
    const trimmed = question.trim()
    if (!trimmed || isLoading) return

    const userMessage = { role: 'user', text: trimmed }

    // Extract recent conversation history to send to backend
    const historyPayload = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map(m => ({
        role: m.role,
        content: m.text,
      }))

    const isFirstQuestion = messages.length === 0

    // Add user message to state immediately
    setConversations(prev =>
      prev.map(conv => {
        if (conv.id === currentChatId) {
          return {
            ...conv,
            title: isFirstQuestion
              ? trimmed.slice(0, 36) + (trimmed.length > 36 ? '...' : '')
              : conv.title,
            messages: [...conv.messages, userMessage],
          }
        }
        return conv
      })
    )

    setQuestion('')
    setIsLoading(true)

    try {
      const response = await fetch(`${BACKEND_URL}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          conversation_id: currentChatId,
          history: historyPayload,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        const errorText = data.detail || 'Something went wrong.'
        setConversations(prev =>
          prev.map(conv =>
            conv.id === currentChatId
              ? { ...conv, messages: [...conv.messages, { role: 'error', text: errorText }] }
              : conv
          )
        )
      } else {
        const assistantMessage = {
          role: 'assistant',
          text: data.answer,
          sources: data.sources || [],
        }
        setConversations(prev =>
          prev.map(conv =>
            conv.id === currentChatId
              ? { ...conv, messages: [...conv.messages, assistantMessage] }
              : conv
          )
        )
      }
    } catch {
      setConversations(prev =>
        prev.map(conv =>
          conv.id === currentChatId
            ? {
                ...conv,
                messages: [
                  ...conv.messages,
                  {
                    role: 'error',
                    text: 'Could not reach the backend. Make sure the FastAPI server is running on port 8000.',
                  },
                ],
              }
            : conv
        )
      )
    } finally {
      setIsLoading(false)
    }
  }

  // ── Handle Enter key in the textarea ──────────────────────────────────────
  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendQuestion()
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Slide-out Conversations Drawer ── */}
      {isSidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)}>
          <aside className="sidebar-drawer" onClick={e => e.stopPropagation()}>
            <div className="sidebar-header">
              <h2>Saved Chats</h2>
              <button
                className="close-btn"
                onClick={() => setIsSidebarOpen(false)}
                title="Close drawer"
              >
                ✕
              </button>
            </div>

            <button className="new-chat-sidebar-btn" onClick={handleNewChat}>
              + Start New Chat
            </button>

            <div className="sidebar-chat-list">
              {conversations.map(conv => {
                const isActive = conv.id === currentChatId
                const messageCount = conv.messages ? conv.messages.length : 0
                return (
                  <div
                    key={conv.id}
                    className={`sidebar-chat-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleSelectConversation(conv.id)}
                  >
                    <div className="sidebar-chat-info">
                      <span className="sidebar-chat-title">{conv.title || 'Untitled Chat'}</span>
                      <span className="sidebar-chat-meta">
                        {messageCount} {messageCount === 1 ? 'message' : 'messages'}
                      </span>
                    </div>
                    <button
                      className="delete-chat-btn"
                      onClick={e => handleDeleteConversation(conv.id, e)}
                      title="Delete conversation"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          </aside>
        </div>
      )}

      {/* ── Header ── */}
      <header className="header">
        <div className="header-top">
          <div className="header-left">
            <button
              className="history-toggle-btn"
              onClick={() => setIsSidebarOpen(true)}
              title="View saved conversations"
            >
              ☰ Chats ({conversations.length})
            </button>
            <div className="title-group">
              <h1>RAG Chat</h1>
              <p>Ask questions grounded in your documents</p>
            </div>
          </div>

          <div className="header-right">
            <button
              className="action-btn"
              onClick={handleNewChat}
              title="Start a new conversation"
            >
              + New Chat
            </button>
            <button
              className="action-btn action-btn-clear"
              onClick={handleClearChat}
              title="Clear current conversation"
              disabled={messages.length === 0}
            >
              Clear
            </button>
            <div className="status-badge">
              <div className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
              {statusMessage}
            </div>
          </div>
        </div>
      </header>

      {/* ── Chat area ── */}
      <main className="chat-area">

        {/* Welcome message — only shown when chat is empty */}
        {messages.length === 0 && !isLoading && (
          <div className="welcome-container">
            <p className="welcome-message">
              Hello! Ask a question about your documents.
            </p>
            <p className="welcome-submessage">
              Follow-up questions are supported (e.g., &quot;What are its key benefits?&quot;).
            </p>
          </div>
        )}

        {/* Render all messages in chronological order */}
        {messages.map((msg, index) => {
          if (msg.role === 'error') {
            return (
              <div key={index} className="error-message">
                ⚠ {msg.text}
              </div>
            )
          }

          const isUser = msg.role === 'user'

          return (
            <div key={index} className={`message ${msg.role}`}>
              <span className="message-label">
                {isUser ? 'You' : 'Assistant'}
              </span>
              <div className={`message-bubble ${isUser ? '' : 'markdown-body'}`}>
                {isUser ? (
                  msg.text
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ node: _node, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer" />
                      ),
                      table: ({ node: _node, ...props }) => (
                        <div className="table-wrapper">
                          <table {...props} />
                        </div>
                      ),
                    }}
                  >
                    {msg.text || ''}
                  </ReactMarkdown>
                )}
              </div>

              {/* Show sources if the assistant provided them */}
              {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                <details className="sources">
                  <summary>View source excerpts ({msg.sources.length})</summary>
                  {msg.sources.map((src, i) => (
                    <div key={i} className="source-item">
                      {src}
                    </div>
                  ))}
                </details>
              )}
            </div>
          )
        })}

        {/* Thinking indicator while waiting for the backend */}
        {isLoading && <p className="thinking">Thinking...</p>}

        {/* Invisible div at the bottom — we scroll here */}
        <div ref={chatEndRef} />
      </main>

      {/* ── Input area ── */}
      <footer className="input-area">
        <textarea
          className="question-input"
          rows={1}
          placeholder="Ask a question... (Enter to send, Shift+Enter for new line)"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
        />
        <button
          className="send-button"
          onClick={sendQuestion}
          disabled={isLoading || !question.trim()}
        >
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </footer>

    </div>
  )
}

export default App
