const SibApiV3Sdk = require('sib-api-v3-sdk');
const config = require('../../config/config');
const logger = require('../utils/logger');

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = config.email.brevoApiKey;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

/**
 * Service pour l'envoi d'emails via Brevo
 */
class MailService {
  /**
   * Envoyer un email de bienvenue
   * @param {string} email - Email du destinataire
   * @param {string} name - Nom du destinataire
   */
  async sendWelcomeEmail(email, name) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Bienvenue sur Meet Me !";
    sendSmtpEmail.htmlContent = `
      <html>
        <body>
          <h1>Bienvenue ${name}!</h1>
          <p>Nous sommes ravis de vous compter parmi nous sur Meet Me.</p>
          <p>Commencez dès maintenant à discuter avec vos proches et profitez de nos fonctionnalités de traduction instantanée.</p>
          <br>
          <p>L'équipe Meet Me</p>
        </body>
      </html>
    `;
    sendSmtpEmail.sender = { name: "Meet Me Team", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email, name: name }];

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      logger.info(`Email de bienvenue envoyé à: ${email}`);
    } catch (error) {
      logger.error(`Erreur détaillée Brevo pour ${email}:`, error.response?.body || error);
    }
  }

  /**
   * Envoyer un code OTP pour la réinitialisation du mot de passe
   * @param {string} email - Email du destinataire
   * @param {string} otp - Code OTP
   */
  async sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Votre code de réinitialisation Meet Me";
    sendSmtpEmail.htmlContent = `
      <html>
        <body>
          <h1>Réinitialisation de votre mot de passe</h1>
          <p>Vous avez demandé la réinitialisation de votre mot de passe sur Meet Me.</p>
          <p>Voici votre code OTP de vérification :</p>
          <h2 style="color: #4A90E2; letter-spacing: 5px;">${otp}</h2>
          <p>Ce code est valable pendant 15 minutes. Si vous n'êtes pas à l'origine de cette demande, veuillez ignorer cet email.</p>
          <br>
          <p>L'équipe Meet Me</p>
        </body>
      </html>
    `;
    sendSmtpEmail.sender = { name: "Meet Me Team", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email }];

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      logger.info(`Email OTP envoyé à: ${email}`);
    } catch (error) {
      logger.error(`Erreur détaillée Brevo pour ${email}:`, error.response?.body || error);
    }
  }
}

module.exports = new MailService();
