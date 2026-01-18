import { $state, $effect, render } from 'fict'

interface FormData {
  username: string
  email: string
  password: string
  gender: 'male' | 'female' | 'other' | ''
  country: string
  newsletter: boolean
  terms: boolean
}

interface FormErrors {
  username?: string
  email?: string
  password?: string
  gender?: string
  country?: string
  terms?: string
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function FormExample() {
  let formData: FormData = $state({
    username: '',
    email: '',
    password: '',
    gender: '',
    country: '',
    newsletter: false,
    terms: false,
  })

  let errors: FormErrors = $state({})
  let submitted = $state(false)
  let isValidating = $state(false)

  const validate = (): boolean => {
    const newErrors: FormErrors = {}

    if (!formData.username.trim()) {
      newErrors.username = 'Username is required'
    } else if (formData.username.length < 3) {
      newErrors.username = 'Username must be at least 3 characters'
    }

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required'
    } else if (!validateEmail(formData.email)) {
      newErrors.email = 'Please enter a valid email'
    }

    if (!formData.password) {
      newErrors.password = 'Password is required'
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters'
    }

    if (!formData.gender) {
      newErrors.gender = 'Please select a gender'
    }

    if (!formData.country) {
      newErrors.country = 'Please select a country'
    }

    if (!formData.terms) {
      newErrors.terms = 'You must accept the terms'
    }

    errors = newErrors
    return Object.keys(newErrors).length === 0
  }

  $effect(() => {
    if (isValidating) {
      validate()
    }
  })

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    isValidating = true
    if (validate()) {
      submitted = true
      console.log('Form submitted:', formData)
    }
  }

  const handleReset = () => {
    formData = {
      username: '',
      email: '',
      password: '',
      gender: '',
      country: '',
      newsletter: false,
      terms: false,
    }
    errors = {}
    submitted = false
    isValidating = false
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>📝 Fict Forms</h1>

      {submitted ? (
        <div style={styles.successCard}>
          <h2 style={styles.successTitle}>✅ Registration Successful!</h2>
          <div style={styles.summaryGrid}>
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Username:</span>
              <span style={styles.summaryValue}>{formData.username}</span>
            </div>
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Email:</span>
              <span style={styles.summaryValue}>{formData.email}</span>
            </div>
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Gender:</span>
              <span style={styles.summaryValue}>{formData.gender}</span>
            </div>
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Country:</span>
              <span style={styles.summaryValue}>{formData.country}</span>
            </div>
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Newsletter:</span>
              <span style={styles.summaryValue}>{formData.newsletter ? 'Yes' : 'No'}</span>
            </div>
          </div>
          <button onClick={handleReset} style={styles.resetButton}>
            Register Another
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={styles.form}>
          {/* Username Field */}
          <div style={styles.field}>
            <label style={styles.label}>Username</label>
            <input
              type="text"
              value={formData.username}
              onInput={(e: Event) => {
                formData.username = (e.target as HTMLInputElement).value
              }}
              placeholder="Enter username"
              style={{
                ...styles.input,
                ...(errors.username ? styles.inputError : {}),
              }}
            />
            {errors.username && <span style={styles.errorText}>{errors.username}</span>}
          </div>

          {/* Email Field */}
          <div style={styles.field}>
            <label style={styles.label}>Email</label>
            <input
              type="email"
              value={formData.email}
              onInput={(e: Event) => {
                formData.email = (e.target as HTMLInputElement).value
              }}
              placeholder="Enter email"
              style={{
                ...styles.input,
                ...(errors.email ? styles.inputError : {}),
              }}
            />
            {errors.email && <span style={styles.errorText}>{errors.email}</span>}
          </div>

          {/* Password Field */}
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={formData.password}
              onInput={(e: Event) => {
                formData.password = (e.target as HTMLInputElement).value
              }}
              placeholder="Enter password"
              style={{
                ...styles.input,
                ...(errors.password ? styles.inputError : {}),
              }}
            />
            {errors.password && <span style={styles.errorText}>{errors.password}</span>}
          </div>

          {/* Gender Radio Buttons */}
          <div style={styles.field}>
            <label style={styles.label}>Gender</label>
            <div style={styles.radioGroup}>
              {(['male', 'female', 'other'] as const).map(option => (
                <label key={option} style={styles.radioLabel}>
                  <input
                    type="radio"
                    name="gender"
                    value={option}
                    checked={formData.gender === option}
                    onChange={() => {
                      formData.gender = option
                    }}
                    style={styles.radio}
                  />
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </label>
              ))}
            </div>
            {errors.gender && <span style={styles.errorText}>{errors.gender}</span>}
          </div>

          {/* Country Select */}
          <div style={styles.field}>
            <label style={styles.label}>Country</label>
            <select
              value={formData.country}
              onChange={(e: Event) => {
                formData.country = (e.target as HTMLSelectElement).value
              }}
              style={{
                ...styles.select,
                ...(errors.country ? styles.inputError : {}),
              }}
            >
              <option value="">Select a country</option>
              <option value="us">United States</option>
              <option value="uk">United Kingdom</option>
              <option value="cn">China</option>
              <option value="jp">Japan</option>
              <option value="de">Germany</option>
              <option value="fr">France</option>
            </select>
            {errors.country && <span style={styles.errorText}>{errors.country}</span>}
          </div>

          {/* Newsletter Checkbox */}
          <div style={styles.checkboxField}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={formData.newsletter}
                onChange={() => {
                  formData.newsletter = !formData.newsletter
                }}
                style={styles.checkbox}
              />
              Subscribe to newsletter
            </label>
          </div>

          {/* Terms Checkbox */}
          <div style={styles.checkboxField}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={formData.terms}
                onChange={() => {
                  formData.terms = !formData.terms
                }}
                style={styles.checkbox}
              />
              I accept the terms and conditions
            </label>
            {errors.terms && <span style={styles.errorText}>{errors.terms}</span>}
          </div>

          {/* Submit Button */}
          <button type="submit" style={styles.submitButton}>
            Register
          </button>
        </form>
      )}

      {/* Live Preview */}
      {!submitted && (
        <div style={styles.preview}>
          <h3 style={styles.previewTitle}>📋 Live Form State</h3>
          <pre style={styles.previewCode}>{JSON.stringify(formData, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: {
    maxWidth: '500px',
    margin: '40px auto',
    padding: '24px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.1)',
  },
  title: {
    textAlign: 'center' as const,
    color: '#1a1a2e',
    marginBottom: '28px',
    fontSize: '28px',
    fontWeight: '700' as const,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '20px',
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  label: {
    fontSize: '14px',
    fontWeight: '600' as const,
    color: '#374151',
  },
  input: {
    padding: '12px 16px',
    fontSize: '16px',
    border: '2px solid #e5e7eb',
    borderRadius: '10px',
    outline: 'none',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    backgroundColor: '#f9fafb',
  },
  inputError: {
    borderColor: '#ef4444',
    backgroundColor: '#fef2f2',
  },
  select: {
    padding: '12px 16px',
    fontSize: '16px',
    border: '2px solid #e5e7eb',
    borderRadius: '10px',
    outline: 'none',
    backgroundColor: '#f9fafb',
    cursor: 'pointer',
  },
  radioGroup: {
    display: 'flex',
    gap: '20px',
    marginTop: '4px',
  },
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '14px',
    color: '#4b5563',
    cursor: 'pointer',
  },
  radio: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  checkboxField: {
    marginTop: '4px',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '14px',
    color: '#4b5563',
    cursor: 'pointer',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  errorText: {
    fontSize: '13px',
    color: '#ef4444',
    marginTop: '2px',
  },
  submitButton: {
    marginTop: '8px',
    padding: '14px 24px',
    fontSize: '16px',
    fontWeight: '600' as const,
    backgroundColor: '#6366f1',
    color: 'white',
    border: 'none',
    borderRadius: '10px',
    cursor: 'pointer',
    transition: 'background-color 0.2s, transform 0.1s',
  },
  successCard: {
    padding: '24px',
    backgroundColor: '#ecfdf5',
    borderRadius: '12px',
    border: '2px solid #10b981',
  },
  successTitle: {
    color: '#059669',
    marginBottom: '20px',
    fontSize: '22px',
    textAlign: 'center' as const,
  },
  summaryGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  summaryItem: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 12px',
    backgroundColor: 'white',
    borderRadius: '8px',
  },
  summaryLabel: {
    fontWeight: '600' as const,
    color: '#374151',
  },
  summaryValue: {
    color: '#059669',
  },
  resetButton: {
    marginTop: '20px',
    width: '100%',
    padding: '12px',
    fontSize: '14px',
    fontWeight: '600' as const,
    backgroundColor: '#059669',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  preview: {
    marginTop: '24px',
    padding: '16px',
    backgroundColor: '#1e293b',
    borderRadius: '12px',
  },
  previewTitle: {
    color: '#94a3b8',
    fontSize: '14px',
    marginBottom: '12px',
  },
  previewCode: {
    color: '#a5f3fc',
    fontSize: '13px',
    fontFamily: 'Monaco, Consolas, monospace',
    overflow: 'auto',
    whiteSpace: 'pre-wrap' as const,
    margin: 0,
  },
}

const app = document.getElementById('app')
if (app) {
  render(() => <FormExample />, app)
}

export default FormExample
