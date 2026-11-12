jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn(),
  })),
}));
jest.mock('../config/db', () => ({
  query: jest.fn(),
}));
jest.mock('../../config/config', () => ({
  google: { webClientId: 'test-web-client' },
  server: { nodeEnv: 'test' },
}));
jest.mock('../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  errorWithContext: jest.fn(),
}));
jest.mock('../services/mail.service', () => ({}));
jest.mock('../services/device-session.service', () => ({
  ensureDeviceSessionsTable: jest.fn(),
  normalizeIpAddress: jest.fn(),
}));

const { OAuth2Client } = require('google-auth-library');
const { query } = require('../config/db');
const authController = require('./auth.controller');
const googleOAuthClient = OAuth2Client.mock.results[0].value;

const invoke = (req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      resolve({ statusCode: this.statusCode, body });
    },
  };

  authController.loginWithGoogle(req, res, reject);
});

describe('loginWithGoogle', () => {
  beforeEach(() => {
    query.mockReset();
    googleOAuthClient.verifyIdToken.mockReset();
  });

  it('rejects a verified Google email without an existing Acemia profile', async () => {
    googleOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'new-user@example.com', email_verified: true }),
    });
    query.mockResolvedValue({ rows: [] });

    const response = await invoke({
      body: { idToken: 'valid-id-token' },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/Créez d’abord un compte/);
    expect(googleOAuthClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'valid-id-token',
      audience: 'test-web-client',
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM public.profiles WHERE LOWER(email) = $1',
      ['new-user@example.com']
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an unverified Google email before looking up an Acemia profile', async () => {
    googleOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'user@example.com', email_verified: false }),
    });

    const response = await invoke({
      body: { idToken: 'valid-id-token' },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
