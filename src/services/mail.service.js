const SibApiV3Sdk = require('sib-api-v3-sdk');
const config = require('../../config/config');
const logger = require('../utils/logger');

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = config.email.brevoApiKey;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

/**
 * Service pour l'envoi d'emails via Brevo avec template style Amazon
 */
class MailService {
  /**
   * Template de base style Amazon
   */
  _getBaseTemplate(title, content, preheader = "") {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Amazon Ember', 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f3f3f3; color: #111; }
          .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #ddd; }
          .header { padding: 20px; text-align: center; border-bottom: 1px solid #f3f3f3; }
          .logo { color: #673AB7; font-size: 28px; font-weight: bold; text-decoration: none; }
          .content { padding: 40px 30px; line-height: 1.6; }
          .title { font-size: 24px; font-weight: 500; margin-bottom: 20px; color: #111; }
          .footer { background-color: #232f3e; color: #ffffff; padding: 40px 20px; text-align: center; font-size: 13px; }
          .social-icons { margin-bottom: 25px; }
          .social-icons a { display: inline-block; margin: 0 10px; text-decoration: none; }
          .social-icons img { width: 24px; height: 24px; filter: brightness(0) invert(1); }
          .footer-links { margin-bottom: 20px; }
          .footer-links a { color: #ffffff; text-decoration: none; margin: 0 10px; border-bottom: 1px solid transparent; }
          .footer-links a:hover { border-bottom: 1px solid #ffffff; }
          .address { color: #999; font-size: 11px; margin-top: 20px; }
          .btn { background-color: #FF9900; color: #111; padding: 12px 30px; border-radius: 4px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 20px; }
          .otp-box { background-color: #f7f7f7; border: 1px dashed #ddd; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; color: #673AB7; letter-spacing: 10px; margin: 25px 0; }
        </style>
      </head>
      <body>
        <div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}</div>
        <div class="container">
          <div class="header">
            <a href="#" class="logo">Meet Me</a>
          </div>
          <div class="content">
            <div class="title">${title}</div>
            ${content}
          </div>
          <div class="footer">
            <div class="social-icons">
              <a href="https://www.facebook.com/people/TOGETHE-Tech/61589824992529/" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook">
              </a>
              <a href="https://www.linkedin.com/company/together-tech-solutions" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/3536/3536505.png" alt="LinkedIn">
              </a>
              <a href="https://github.com/kalonji086/Docteur-parle-moi" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/733/733553.png" alt="GitHub">
              </a>
              <a href="https://wa.me/243975186643" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/733/733585.png" alt="WhatsApp">
              </a>
            </div>
            <div class="footer-links">
              <a href="https://meet-me-backend-sg5c.onrender.com/privacy">Politique de confidentialité</a>
              <a href="https://meet-me-backend-sg5c.onrender.com/support/helpdesk">Aide & Support</a>
            </div>
            <div class="address">
              © 2026 Meet Me Team. Tous droits réservés.<br>
              TOGETHE Tech Solutions, 123 Avenue de l'Innovation, Kinshasa, RDC.
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Envoyer un email de bienvenue
   */
  async sendWelcomeEmail(email, name) {
    const title = `Bonjour ${name}, bienvenue sur Meet Me !`;
    const content = `
      <p>Nous sommes ravis de vous accueillir dans la communauté <strong>Meet Me</strong>. Votre compte a été créé avec succès.</p>
      <p>Meet Me vous permet de rester connecté avec vos proches partout dans le monde, avec une traduction intelligente de vos messages en temps réel.</p>
      <p><strong>Voici ce que vous pouvez faire dès maintenant :</strong></p>
      <ul>
        <li>Personnaliser votre profil (photo, pseudo, actu)</li>
        <li>Inviter vos amis via leur pseudo ou numéro</li>
        <li>Changer les couleurs de l'application selon vos goûts</li>
      </ul>
      <div style="text-align: center;">
        <a href="https://play.google.com/apps/internaltest/4701609113157308277" class="btn">DÉCOUVRIR L'APPLICATION</a>
      </div>
      <p style="margin-top: 30px;">Si vous avez des questions, n'hésitez pas à répondre à cet email ou à nous contacter sur WhatsApp.</p>
      <p>L'équipe Meet Me</p>
    `;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Bienvenue sur Meet Me !";
    sendSmtpEmail.htmlContent = this._getBaseTemplate(title, content, "Votre aventure Meet Me commence ici.");
    sendSmtpEmail.sender = { name: "Meet Me Team", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email, name: name }];

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      logger.info(`Email de bienvenue envoyé à: ${email}`);
    } catch (error) {
      logger.error(`Erreur Brevo Welcome pour ${email}:`, error.response?.body || error);
    }
  }

  /**
   * Envoyer un code OTP
   */
  async sendOTPEmail(email, otp) {
    const title = "Vérification de votre compte";
    const content = `
      <p>Vous avez demandé un code de vérification pour votre compte Meet Me.</p>
      <p>Veuillez utiliser le code ci-dessous pour confirmer votre identité. Pour votre sécurité, ne partagez jamais ce code avec personne.</p>
      <div class="otp-box">${otp}</div>
      <p>Ce code est <strong>valable pendant 15 minutes</strong>.</p>
      <p>Si vous n'avez pas demandé ce code, vous pouvez ignorer cet email en toute sécurité. Votre compte reste protégé.</p>
      <div style="text-align: center;">
        <a href="https://play.google.com/apps/internaltest/4701609113157308277" class="btn">OUVRIR L'APPLICATION</a>
      </div>
      <p>À bientôt,<br>L'équipe de sécurité Meet Me</p>
    `;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otp} est votre code Meet Me`;
    sendSmtpEmail.htmlContent = this._getBaseTemplate(title, content, "Votre code de sécurité Meet Me.");
    sendSmtpEmail.sender = { name: "Meet Me Security", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email }];

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      logger.info(`Email OTP envoyé à: ${email}`);
    } catch (error) {
      logger.error(`Erreur Brevo OTP pour ${email}:`, error.response?.body || error);
    }
  }

  /**
   * Envoyer un email de diffusion (Broadcast)
   */
  async sendSystemEmail(email, title, body) {
    const content = `
      <p>${body.replace(/\n/g, '<br>')}</p>
      <div style="text-align: center; margin-top: 30px;">
        <a href="https://play.google.com/apps/internaltest/4701609113157308277" class="btn">DÉCOUVRIR L'APPLICATION</a>
      </div>
    `;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = title;
    sendSmtpEmail.htmlContent = this._getBaseTemplate(title, content, title);
    sendSmtpEmail.sender = { name: "Meet Me Official", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email }];

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      return true;
    } catch (error) {
      logger.error(`Erreur Broadcast Email pour ${email}:`, error.response?.body || error);
      return false;
    }
  }
}

module.exports = new MailService();
