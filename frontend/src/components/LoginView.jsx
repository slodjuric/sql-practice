import { useState } from 'react';
import { api } from '../api';

export default function LoginView({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await api.auth.login(username.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-view">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">SQL Practice</h1>
        <span className="login-subtitle">Sign in to continue</span>

        <label className="login-label" htmlFor="login-username">Username</label>
        <input
          id="login-username"
          className="login-input"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoFocus
          disabled={submitting}
          autoComplete="username"
        />

        <label className="login-label" htmlFor="login-password">Password</label>
        <input
          id="login-password"
          className="login-input"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={submitting}
          autoComplete="current-password"
        />

        {error && <div className="login-error">{error}</div>}

        <button
          className="login-submit"
          type="submit"
          disabled={submitting || !username.trim() || !password}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
