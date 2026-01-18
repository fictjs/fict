import { $state, render, Suspense, ErrorBoundary } from 'fict'
import { resource } from 'fict/plus'

// Simulated API types
interface User {
  id: number
  name: string
  email: string
  avatar: string
}

interface Post {
  id: number
  title: string
  body: string
  userId: number
}

// Simulated API fetchers with artificial delay
const fetchUsers = async ({ signal }: { signal: AbortSignal }): Promise<User[]> => {
  await new Promise(resolve => setTimeout(resolve, 1000))
  if (signal.aborted) throw new Error('Aborted')
  return [
    { id: 1, name: 'Alice Johnson', email: 'alice@example.com', avatar: '👩‍💻' },
    { id: 2, name: 'Bob Smith', email: 'bob@example.com', avatar: '👨‍💼' },
    { id: 3, name: 'Carol Williams', email: 'carol@example.com', avatar: '👩‍🔬' },
    { id: 4, name: 'David Brown', email: 'david@example.com', avatar: '👨‍🎨' },
  ]
}

const fetchPosts = async ({ signal }: { signal: AbortSignal }, userId: number): Promise<Post[]> => {
  await new Promise(resolve => setTimeout(resolve, 800))
  if (signal.aborted) throw new Error('Aborted')

  const allPosts: Record<number, Post[]> = {
    1: [
      {
        id: 1,
        title: 'Getting Started with Fict',
        body: 'Fict is a reactive UI framework...',
        userId: 1,
      },
      {
        id: 2,
        title: 'Advanced Reactivity Patterns',
        body: 'Learn about signals and effects...',
        userId: 1,
      },
    ],
    2: [
      {
        id: 3,
        title: 'Building Scalable Apps',
        body: 'Best practices for large applications...',
        userId: 2,
      },
    ],
    3: [
      {
        id: 4,
        title: 'Testing Reactive UIs',
        body: 'How to test your Fict components...',
        userId: 3,
      },
      { id: 5, title: 'Performance Optimization', body: 'Tips for faster rendering...', userId: 3 },
      {
        id: 6,
        title: 'State Management Deep Dive',
        body: 'Understanding $state and $store...',
        userId: 3,
      },
    ],
    4: [
      {
        id: 7,
        title: 'Creative UI Designs',
        body: 'Inspiration for your next project...',
        userId: 4,
      },
    ],
  }

  return allPosts[userId] || []
}

// Create resources
const usersResource = resource<User[], void>({
  fetch: fetchUsers,
  suspense: true,
})

const postsResource = resource<Post[], number>({
  fetch: fetchPosts,
  suspense: true,
})

// Loading component
function LoadingSpinner() {
  return (
    <div style={styles.loading}>
      <div style={styles.spinner}></div>
      <span style={styles.loadingText}>Loading...</span>
    </div>
  )
}

// Error fallback component
function ErrorFallback(props: { error: Error; reset: () => void }) {
  return (
    <div style={styles.errorCard}>
      <div style={styles.errorIcon}>⚠️</div>
      <h3 style={styles.errorTitle}>Something went wrong</h3>
      <p style={styles.errorMessage}>{props.error.message}</p>
      <button onClick={props.reset} style={styles.retryButton}>
        Try Again
      </button>
    </div>
  )
}

// User card component
function UserCard(props: { user: User; selected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={props.onSelect}
      style={{
        ...styles.userCard,
        ...(props.selected ? styles.userCardSelected : {}),
      }}
    >
      <span style={styles.avatar}>{props.user.avatar}</span>
      <div style={styles.userInfo}>
        <div style={styles.userName}>{props.user.name}</div>
        <div style={styles.userEmail}>{props.user.email}</div>
      </div>
    </div>
  )
}

// Posts list component
function PostsList(props: { userId: number }) {
  const posts = postsResource.read(() => props.userId)

  return (
    <div style={styles.postsContainer}>
      {posts.data?.length === 0 ? (
        <p style={styles.noPosts}>No posts yet</p>
      ) : (
        posts.data?.map(post => (
          <div key={post.id} style={styles.postCard}>
            <h4 style={styles.postTitle}>{post.title}</h4>
            <p style={styles.postBody}>{post.body}</p>
          </div>
        ))
      )}
    </div>
  )
}

// Users list component
function UsersList(props: { selectedId: number | null; onSelect: (id: number) => void }) {
  const users = usersResource.read(undefined)

  return (
    <div style={styles.usersList}>
      {users.data?.map(user => (
        <UserCard
          key={user.id}
          user={user}
          selected={props.selectedId === user.id}
          onSelect={() => props.onSelect(user.id)}
        />
      ))}
      <button onClick={() => users.refresh()} style={styles.refreshButton} disabled={users.loading}>
        {users.loading ? '⏳ Refreshing...' : '🔄 Refresh Users'}
      </button>
    </div>
  )
}

// Main App component
function AsyncDataApp() {
  let selectedUserId = $state<number | null>(null)

  const handleSelectUser = (id: number) => {
    selectedUserId = id
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>🔄 Fict Async Data</h1>
      <p style={styles.subtitle}>
        Demonstrating <code style={styles.code}>resource</code> API with{' '}
        <code style={styles.code}>Suspense</code>
      </p>

      <div style={styles.layout}>
        {/* Users Panel */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>👥 Users</h2>
          <ErrorBoundary fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
            <Suspense fallback={<LoadingSpinner />}>
              <UsersList selectedId={selectedUserId} onSelect={handleSelectUser} />
            </Suspense>
          </ErrorBoundary>
        </div>

        {/* Posts Panel */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>📝 Posts</h2>
          {selectedUserId === null ? (
            <div style={styles.placeholder}>
              <span style={styles.placeholderIcon}>👆</span>
              <p style={styles.placeholderText}>Select a user to view their posts</p>
            </div>
          ) : (
            <ErrorBoundary
              fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}
            >
              <Suspense fallback={<LoadingSpinner />}>
                <PostsList userId={selectedUserId} />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </div>

      {/* Info Section */}
      <div style={styles.infoSection}>
        <h3 style={styles.infoTitle}>💡 How it works</h3>
        <ul style={styles.infoList}>
          <li>
            <strong>resource()</strong> - Creates an async data fetching primitive with caching
          </li>
          <li>
            <strong>Suspense</strong> - Shows loading fallback while data is being fetched
          </li>
          <li>
            <strong>ErrorBoundary</strong> - Catches and displays errors gracefully
          </li>
          <li>
            <strong>Automatic refetch</strong> - Changing userId triggers new fetch for posts
          </li>
        </ul>
      </div>
    </div>
  )
}

const styles = {
  container: {
    maxWidth: '900px',
    margin: '40px auto',
    padding: '24px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  title: {
    textAlign: 'center' as const,
    color: '#1a1a2e',
    marginBottom: '8px',
    fontSize: '32px',
    fontWeight: '700' as const,
  },
  subtitle: {
    textAlign: 'center' as const,
    color: '#6b7280',
    fontSize: '16px',
    marginBottom: '32px',
  },
  code: {
    backgroundColor: '#f1f5f9',
    padding: '2px 6px',
    borderRadius: '4px',
    fontFamily: 'Monaco, Consolas, monospace',
    fontSize: '14px',
    color: '#6366f1',
  },
  layout: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.5fr',
    gap: '24px',
  },
  panel: {
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    padding: '20px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)',
  },
  panelTitle: {
    fontSize: '18px',
    fontWeight: '600' as const,
    color: '#374151',
    marginBottom: '16px',
    paddingBottom: '12px',
    borderBottom: '2px solid #f3f4f6',
  },
  usersList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  userCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    backgroundColor: '#f9fafb',
    borderRadius: '12px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    border: '2px solid transparent',
  },
  userCardSelected: {
    backgroundColor: '#eef2ff',
    borderColor: '#6366f1',
  },
  avatar: {
    fontSize: '28px',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontWeight: '600' as const,
    color: '#1f2937',
    fontSize: '15px',
  },
  userEmail: {
    color: '#6b7280',
    fontSize: '13px',
  },
  refreshButton: {
    marginTop: '8px',
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: '500' as const,
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  postsContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  postCard: {
    padding: '16px',
    backgroundColor: '#f9fafb',
    borderRadius: '12px',
    borderLeft: '4px solid #6366f1',
  },
  postTitle: {
    fontSize: '15px',
    fontWeight: '600' as const,
    color: '#1f2937',
    marginBottom: '8px',
  },
  postBody: {
    fontSize: '14px',
    color: '#6b7280',
    lineHeight: '1.5',
    margin: 0,
  },
  noPosts: {
    textAlign: 'center' as const,
    color: '#9ca3af',
    padding: '32px',
  },
  placeholder: {
    textAlign: 'center' as const,
    padding: '48px 24px',
    backgroundColor: '#f9fafb',
    borderRadius: '12px',
  },
  placeholderIcon: {
    fontSize: '48px',
    display: 'block',
    marginBottom: '12px',
  },
  placeholderText: {
    color: '#6b7280',
    fontSize: '15px',
    margin: 0,
  },
  loading: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
    gap: '16px',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid #e5e7eb',
    borderTopColor: '#6366f1',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  loadingText: {
    color: '#6b7280',
    fontSize: '14px',
  },
  errorCard: {
    textAlign: 'center' as const,
    padding: '24px',
    backgroundColor: '#fef2f2',
    borderRadius: '12px',
    border: '2px solid #fecaca',
  },
  errorIcon: {
    fontSize: '40px',
    marginBottom: '12px',
  },
  errorTitle: {
    color: '#dc2626',
    fontSize: '18px',
    marginBottom: '8px',
  },
  errorMessage: {
    color: '#6b7280',
    fontSize: '14px',
    marginBottom: '16px',
  },
  retryButton: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: '500' as const,
    backgroundColor: '#dc2626',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  infoSection: {
    marginTop: '32px',
    padding: '20px',
    backgroundColor: '#eff6ff',
    borderRadius: '12px',
    border: '2px solid #bfdbfe',
  },
  infoTitle: {
    fontSize: '16px',
    fontWeight: '600' as const,
    color: '#1e40af',
    marginBottom: '12px',
  },
  infoList: {
    margin: 0,
    paddingLeft: '20px',
    color: '#3b82f6',
    fontSize: '14px',
    lineHeight: '1.8',
  },
}

// Add spinner animation via style tag
const styleSheet = document.createElement('style')
styleSheet.textContent = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`
document.head.appendChild(styleSheet)

const app = document.getElementById('app')
if (app) {
  render(() => <AsyncDataApp />, app)
}

export default AsyncDataApp
