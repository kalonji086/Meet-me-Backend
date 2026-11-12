jest.mock('../config/db', () => ({ query: jest.fn() }));
jest.mock('../middleware/error.middleware', () => ({ asyncHandler: handler => handler }));
jest.mock('../services/socket.service', () => ({ broadcast: jest.fn() }));
jest.mock('./admin.controller', () => ({ processSensitiveAction: jest.fn() }));

const { validateAnnouncement } = require('./announcement.controller');

const announcement = {
  title: 'Nouvelle fonctionnalité',
  content: 'Découvrez cette nouveauté dans Acemia.',
};

describe('validateAnnouncement destination links', () => {
  it('accepts a supported internal page path', () => {
    expect(validateAnnouncement({ ...announcement, linkUrl: '/privacy-policy' }).value.linkUrl)
      .toBe('/privacy-policy');
  });

  it('accepts an HTTPS external URL', () => {
    expect(validateAnnouncement({ ...announcement, linkUrl: 'https://example.com/news' }).value.linkUrl)
      .toBe('https://example.com/news');
  });

  it.each([
    '//example.com',
    'http://example.com',
    'javascript:alert(1)',
    '/not-an-app-page',
  ])('rejects an unsafe or unsupported destination: %s', (linkUrl) => {
    expect(validateAnnouncement({ ...announcement, linkUrl }).error).toBeTruthy();
  });
});
