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
  jwt: {
    secret: 'test-access-secret',
    refreshSecret: 'test-refresh-secret',
    expire: '1h',
    refreshExpire: '30d',
  },
  server: { nodeEnv: 'test' },
}));
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'signed-token'),
  decode: jest.fn(() => ({ exp: 2000000000 })),
}));
jest.mock('../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  errorWithContext: jest.fn(),
}));
jest.mock('../services/mail.service', () => ({
  sendWelcomeEmail: jest.fn(),
}));
jest.mock('../services/socket.service', () => ({
  broadcast: jest.fn(),
}));
jest.mock('../services/device-session.service', () => ({
  ensureDeviceSessionsTable: jest.fn(),
  normalizeIpAddress: jest.fn(() => '127.0.0.1'),
}));

const { OAuth2Client } = require('google-auth-library');
const { query } = require('../config/db');
const authController = require('./auth.controller');
const googleOAuthClient = OAuth2Client.mock.results[0].value;

const invoke = (handler, req) => new Promise((resolve, reject) => {
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

  handler(req, res, reject);
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

    const response = await invoke(authController.loginWithGoogle, {
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

    const response = await invoke(authController.loginWithGoogle, {
      body: { idToken: 'valid-id-token' },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('registerWithGoogle', () => {
  beforeEach(() => {
    query.mockReset();
    googleOAuthClient.verifyIdToken.mockReset();
  });

  it('creates a profile only through explicit Google signup and opens an authenticated session', async () => {
    googleOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'new-user@example.com', email_verified: true }),
    });
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'new-user-id',
          full_name: 'New User',
          email: 'new-user@example.com',
          username: 'newuser',
          phone_number: '+243812345678',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'new-user-id' }] });

    const response = await invoke(authController.registerWithGoogle, {
      body: {
        idToken: 'valid-id-token',
        name: 'New User',
        phone_number: '+243812345678',
        username: 'newuser',
        gender: 'M',
        country: 'République Démocratique du Congo',
        province: 'Kinshasa',
        city: 'Kinshasa',
        commune: 'Gombe',
        birth_date: '1995-01-01',
        device_info: { model: 'test device' },
        appVersion: '1.0.0',
        accepted_legal_version: '1',
        accepted_tos_version: '1',
        accepted_privacy_version: '1',
      },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe('new-user@example.com');
    expect(response.body.data.token).toBe('signed-token');
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[2][1][2]).toBe('new-user@example.com');
    expect(query.mock.calls[2][1][3]).toBe('hashed-password');
    expect(googleOAuthClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'valid-id-token',
      audience: 'test-web-client',
    });
  });

  it('rejects an unverified Google email without creating a profile', async () => {
    googleOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'new-user@example.com', email_verified: false }),
    });

    const response = await invoke(authController.registerWithGoogle, {
      body: { idToken: 'valid-id-token' },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not create another profile when the Google email already exists', async () => {
    googleOAuthClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'existing@example.com', email_verified: true }),
    });
    query.mockResolvedValue({ rows: [{ id: 'existing-user-id' }] });

    const response = await invoke(authController.registerWithGoogle, {
      body: {
        idToken: 'valid-id-token',
        name: 'Existing User',
        phone_number: '+243812345678',
        birth_date: '1995-01-01',
      },
      ip: '127.0.0.1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
