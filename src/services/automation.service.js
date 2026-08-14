const cron = require('node-cron');
const { query } = require('../config/db');
const mailService = require('./mail.service');
const socketService = require('./socket.service');
const logger = require('../utils/logger');

class AutomationService {
  constructor() {
    this.isInitialized = false;
  }

  initialize() {
    if (this.isInitialized) return;

    // 1. Chaque minute : Vérifier les envois programmés (Scheduled)
    cron.schedule('* * * * *', () => {
      this.processScheduledCampaigns();
    });

    // 2. Chaque jour à 10h00 : Relancer les utilisateurs inactifs (Retention)
    cron.schedule('0 10 * * *', () => {
      this.reengageInactiveUsers();
    });

    // 3. Chaque jour à 18h00 : Vérifier les profils incomplets
    cron.schedule('0 18 * * *', () => {
      this.remindIncompleteProfiles();
    });

    this.isInitialized = true;
    logger.info('🚀 Service d\'automatisation initialisé (Cron Jobs actifs)');
  }

  /**
   * Traite les campagnes dont l'heure d'envoi est arrivée
   */
  async processScheduledCampaigns() {
    try {
      // S'assurer que les tables admin existent
      const { ensureAdminTables } = require('../controllers/admin.controller');
      await ensureAdminTables();

      const now = new Date().toISOString();
      const pending = await query(
        `SELECT * FROM public.notification_campaigns
         WHERE status = 'scheduled' AND scheduled_at <= $1`,
        [now]
      );

      for (const campaign of pending.rows) {
        logger.info(`📧 Exécution de la campagne programmée : ${campaign.title}`);

        // Mettre à jour le statut en 'processing' pour éviter les doubles envois
        await query('UPDATE public.notification_campaigns SET status = \'processing\' WHERE id = $1', [campaign.id]);

        const metadata = campaign.metadata || {};
        const theme = metadata.theme || 'amazon';

        let targetEmails = [];
        if (campaign.target === 'all') {
          const users = await query('SELECT email FROM public.profiles WHERE is_global_admin = FALSE');
          targetEmails = users.rows.map(u => u.email);
        } else if (campaign.target_value) {
          targetEmails = campaign.target_value.split(',').map(e => e.trim()).filter(e => e);
        }

        let sentCount = 0;
        for (const email of targetEmails) {
          const success = await mailService.sendSystemEmail(email, campaign.title, campaign.message, theme);
          if (success) sentCount++;

          // Petit délai pour ne pas saturer le service mail
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        await query(
          'UPDATE public.notification_campaigns SET status = \'sent\', sent_count = $1, updated_at = NOW() WHERE id = $2',
          [sentCount, campaign.id]
        );

        logger.info(`✅ Campagne "${campaign.title}" terminée. Envoyée à ${sentCount} destinataires.`);
      }
    } catch (error) {
      logger.error('Erreur processScheduledCampaigns:', error);
    }
  }

  /**
   * Relance les utilisateurs n'ayant pas ouvert l'app depuis 3 jours
   */
  async reengageInactiveUsers() {
    try {
      // Utilisateurs inactifs depuis plus de 3 jours
      const inactiveLimit = new Date();
      inactiveLimit.setDate(inactiveLimit.getDate() - 3);

      const result = await query(
        `SELECT id, email, full_name FROM public.profiles
         WHERE last_login_at <= $1 AND is_global_admin = FALSE AND is_locked = FALSE`,
        [inactiveLimit.toISOString()]
      );

      if (result.rows.length === 0) return;

      const title = "Tu nous manques sur Meet Me ! 👋";
      const message = "Tes amis t'attendent ! Reviens voir ce qu'il y a de nouveau et continue tes conversations.";

      for (const user of result.rows) {
        await mailService.sendSystemEmail(user.email, title, message);
        socketService.sendToUser(user.id, 'push_notification', {
          title,
          body: message,
          type: 'retention'
        });
      }

      logger.info(`📉 Relance effectuée pour ${result.rows.length} utilisateurs inactifs.`);
    } catch (error) {
      logger.error('Erreur reengageInactiveUsers:', error);
    }
  }

  /**
   * Rappel pour ceux qui n'ont pas encore configuré leur profil
   */
  async remindIncompleteProfiles() {
    try {
      const result = await query(
        `SELECT id, email, full_name FROM public.profiles
         WHERE (avatar_url IS NULL OR username IS NULL)
         AND is_global_admin = FALSE AND is_locked = FALSE`
      );

      if (result.rows.length === 0) return;

      const title = "Complète ton profil Meet Me ✨";
      const message = "Ajoute une photo et un pseudo pour que tes amis puissent te reconnaître plus facilement.";

      for (const user of result.rows) {
        await mailService.sendSystemEmail(user.email, title, message);
      }
    } catch (error) {
      logger.error('Erreur remindIncompleteProfiles:', error);
    }
  }
}

module.exports = new AutomationService();
