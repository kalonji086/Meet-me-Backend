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
   * Template de base avec thèmes
   */
  _getBaseTemplate(title, content, preheader = "", theme = "amazon") {
    let primaryColor = "#673AB7";
    let bgColor = "#f3f3f3";
    let containerBg = "#ffffff";
    let textColor = "#111111";
    let footerBg = "#232f3e";
    let buttonColor = "#FF9900";
    let buttonText = "#111111";

    if (theme === "modern") {
      primaryColor = "#008069"; // Style WhatsApp
      buttonColor = "#25D366";
      buttonText = "#ffffff";
    } else if (theme === "dark") {
      bgColor = "#121212";
      containerBg = "#1e1e1e";
      textColor = "#eeeeee";
      footerBg = "#000000";
    } else if (theme === "minimal") {
      bgColor = "#ffffff";
      containerBg = "#ffffff";
      footerBg = "#f8f9fa";
      textColor = "#333333";
      primaryColor = "#333333";
    }

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background-color: ${bgColor}; color: ${textColor}; }
          .container { max-width: 600px; margin: 20px auto; background-color: ${containerBg}; border-radius: 12px; border: 1px solid #ddd; overflow: hidden; }
          .header { padding: 30px; text-align: center; border-bottom: 1px solid #f3f3f3; }
          .logo { color: ${primaryColor}; font-size: 32px; font-weight: bold; text-decoration: none; letter-spacing: -1px; }
          .content { padding: 40px 35px; line-height: 1.7; min-height: 200px; font-size: 16px; }
          .content img { max-width: 100%; height: auto; border-radius: 8px; margin: 20px 0; display: block; }
          .title { font-size: 26px; font-weight: 700; margin-bottom: 25px; color: ${textColor}; }
          .footer { background-color: ${footerBg}; color: #ffffff; padding: 50px 20px; text-align: center; font-size: 13px; clear: both; }
          .social-icons { margin-bottom: 25px; }
          .social-icons a { display: inline-block; margin: 0 12px; text-decoration: none; }
          .social-icons img { width: 22px; height: 22px; filter: brightness(0) invert(1); }
          .footer-links { margin-bottom: 25px; }
          .footer-links a { color: #ffffff; text-decoration: none; margin: 0 12px; border-bottom: 1px solid transparent; opacity: 0.8; }
          .footer-links a:hover { border-bottom: 1px solid #ffffff; opacity: 1; }
          .address { color: #aaaaaa; font-size: 11px; margin-top: 25px; line-height: 1.6; }
          .btn { background-color: ${buttonColor}; color: ${buttonText} !important; padding: 14px 35px; border-radius: 30px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 25px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .otp-box { background-color: #f7f7f7; border: 2px dashed ${primaryColor}; padding: 25px; text-align: center; font-size: 36px; font-weight: bold; color: ${primaryColor}; letter-spacing: 12px; margin: 30px 0; border-radius: 10px; }
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
              <a href="https://wa.me/243975186643" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/733/733585.png" alt="WhatsApp">
              </a>
              <a href="https://github.com/kalonji086/Docteur-parle-moi" target="_blank">
                <img src="https://cdn-icons-png.flaticon.com/512/733/733553.png" alt="GitHub">
              </a>
            </div>
            <div class="footer-links">
              <a href="https://meet-me-backend-sg5c.onrender.com/privacy">Confidentialité</a>
              <a href="https://meet-me-backend-sg5c.onrender.com/support/helpdesk">Support</a>
            </div>
            <div class="address">
              © 2026 Meet Me Team. TOGETHE Tech Solutions.<br>
              Kinshasa, République Démocratique du Congo.
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
  async sendSystemEmail(email, title, body, theme = "amazon", name = "Utilisateur") {
    // Personnalisation du corps du message
    let personalizedBody = body;
    personalizedBody = personalizedBody.replace(/\{\{name\}\}/g, name);
    personalizedBody = personalizedBody.replace(/\{\{full_name\}\}/g, name);
    personalizedBody = personalizedBody.replace(/\{\{email\}\}/g, email);

    const content = `
      <div class="rich-text-content">
        ${personalizedBody}
      </div>
      <div style="text-align: center; margin-top: 30px;">
        <a href="https://play.google.com/apps/internaltest/4701609113157308277" class="btn">DÉCOUVRIR L'APPLICATION</a>
      </div>
    `;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = personalizedBody.includes(title) ? title : title; // title is usually plain text
    sendSmtpEmail.htmlContent = this._getBaseTemplate(title, content, title, theme);
    sendSmtpEmail.sender = { name: "Meet Me Official", email: config.email.emailFrom };
    sendSmtpEmail.to = [{ email: email, name: name }];

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
