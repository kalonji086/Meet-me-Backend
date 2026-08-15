const axios = require('axios');
const NodeCache = require('node-cache');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const config = require('../../config/config');

// Cache pour les traductions (éviter les appels API répétés)
const translationCache = new NodeCache({
  stdTTL: config.translation.cacheDuration / 1000, // Convertir ms en secondes
  checkperiod: 600, // Vérifier les entrées expirées toutes les 10 minutes
});

class TranslationService {
  constructor() {
    this.provider = config.translation.provider;
    this.googleApiKey = config.translation.googleApiKey;
    this.deeplApiKey = config.translation.deeplApiKey;
    this.openaiApiKey = config.translation.openaiApiKey;
    
    this.validateConfig();
  }

  validateConfig() {
    if (!this.googleApiKey && !this.deeplApiKey && !this.openaiApiKey) {
      logger.warn(`Aucune clé API de traduction configurée. Le service fonctionnera en mode simulé.`);
    }
  }

  /**
   * Traduire un texte d'une langue source à une langue cible
   */
  async translate(text, targetLanguage, sourceLanguage = 'auto') {
    try {
      // Vérifier si la traduction est en cache
      const cacheKey = `${text}:${sourceLanguage}:${targetLanguage}`;
      const cachedTranslation = translationCache.get(cacheKey);
      
      if (cachedTranslation) {
        logger.debug(`Traduction récupérée depuis le cache: ${cacheKey}`);
        return cachedTranslation;
      }

      let translatedText;

      // Utiliser l'IA (OpenAI) en priorité si configuré, sinon Google/DeepL
      if (this.openaiApiKey) {
        translatedText = await this.translateWithOpenAI(text, targetLanguage, sourceLanguage);
      } else if (this.provider === 'google' && this.googleApiKey) {
        translatedText = await this.translateWithGoogle(text, targetLanguage, sourceLanguage);
      } else if (this.provider === 'deepl' && this.deeplApiKey) {
        translatedText = await this.translateWithDeepL(text, targetLanguage, sourceLanguage);
      } else {
        logger.debug('Mode traduction simulé (pas de clé API configurée)');
        translatedText = this.getMockTranslation(text, targetLanguage);
      }

      // Mettre en cache la traduction
      translationCache.set(cacheKey, translatedText);

      logger.debug(`Texte traduit: "${text.substring(0, 50)}..." -> "${translatedText.substring(0, 50)}..."`);
      
      return translatedText;
    } catch (error) {
      logger.error('Erreur lors de la traduction:', error);
      return this.getMockTranslation(text, targetLanguage);
    }
  }

  /**
   * Traduction avec OpenAI GPT (Mode IA)
   */
  async translateWithOpenAI(text, targetLanguage, sourceLanguage = 'auto') {
    const url = 'https://api.openai.com/v1/chat/completions';

    const prompt = `Translate the following text to ${targetLanguage}.
    ${sourceLanguage !== 'auto' ? `Source language is ${sourceLanguage}.` : ''}
    Only return the translated text without any explanations.
    Text: "${text}"`;

    const response = await axios.post(url, {
      model: "gpt-4o-mini", // Utilisation d'un modèle rapide et économique
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    }, {
      headers: {
        'Authorization': `Bearer ${this.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    if (response.data && response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content.trim();
    }

    throw new Error('Réponse invalide de OpenAI API');
  }

  /**
   * Traduction et Transcription Audio avec OpenAI Whisper (Mode IA Vocal)
   */
  async transcribeAndTranslateAudio(filePath, targetLanguage) {
    try {
      if (!this.openaiApiKey) {
        throw new Error('OpenAI API Key non configurée pour la transcription');
      }

      // 1. Transcription avec Whisper
      const whisperUrl = 'https://api.openai.com/v1/audio/transcriptions';
      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath));
      formData.append('model', 'whisper-1');

      const transcriptionRes = await axios.post(whisperUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${this.openaiApiKey}`,
        },
        timeout: 30000,
      });

      const originalText = transcriptionRes.data.text;

      // 2. Traduction du texte transcrit
      const translatedText = await this.translate(originalText, targetLanguage);

      return {
        originalText,
        translatedText
      };
    } catch (error) {
      logger.error('Erreur transcription/traduction audio:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Traduction avec Google Translate API
   */
  async translateWithGoogle(text, targetLanguage, sourceLanguage = 'auto') {
    const url = 'https://translation.googleapis.com/language/translate/v2';
    
    const response = await axios.post(url, null, {
      params: {
        q: text,
        target: targetLanguage,
        source: sourceLanguage,
        key: this.googleApiKey,
        format: 'text',
      },
      timeout: 10000,
    });

    if (response.data && response.data.data && response.data.data.translations) {
      return response.data.data.translations[0].translatedText;
    }

    throw new Error('Réponse invalide de Google Translate API');
  }

  /**
   * Traduction avec DeepL API
   */
  async translateWithDeepL(text, targetLanguage, sourceLanguage = 'auto') {
    const url = 'https://api-free.deepl.com/v2/translate';
    
    const params = new URLSearchParams();
    params.append('text', text);
    params.append('target_lang', targetLanguage.toUpperCase());
    
    if (sourceLanguage !== 'auto') {
      params.append('source_lang', sourceLanguage.toUpperCase());
    }

    const response = await axios.post(url, params, {
      headers: {
        'Authorization': `DeepL-Auth-Key ${this.deeplApiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });

    if (response.data && response.data.translations) {
      return response.data.translations[0].text;
    }

    throw new Error('Réponse invalide de DeepL API');
  }

  /**
   * Traduction simulée pour le développement
   */
  getMockTranslation(text, targetLanguage) {
    // Simuler une traduction en ajoutant un préfixe
    const languageNames = {
      fr: 'Français',
      en: 'Anglais',
      es: 'Espagnol',
      de: 'Allemand',
      it: 'Italien',
      pt: 'Portugais',
      ru: 'Russe',
      zh: 'Chinois',
      ja: 'Japonais',
      ko: 'Coréen',
      ar: 'Arabe',
    };

    const languageName = languageNames[targetLanguage] || targetLanguage;
    return `[Traduit en ${languageName}] ${text}`;
  }

  /**
   * Traduire un message complet avec gestion du cache
   */
  async translateMessage(messageId, targetLanguage) {
    try {
      const result = await query(
        'SELECT * FROM public.messages WHERE id = $1',
        [messageId]
      );
      const message = result.rows[0];

      if (!message) {
        throw new Error('Message non trouvé');
      }

      // Vérifier si la traduction existe déjà
      let translatedContent = {};
      try {
        translatedContent = typeof message.translated_content === 'string'
          ? JSON.parse(message.translated_content)
          : (message.translated_content || {});
      } catch (e) {
        translatedContent = {};
      }

      if (translatedContent[targetLanguage]) {
        return translatedContent[targetLanguage];
      }

      // Traduire le contenu
      const textToTranslate = message.content || '';
      if (!textToTranslate.trim()) {
        throw new Error('Aucun texte à traduire');
      }

      const translatedText = await this.translate(textToTranslate, targetLanguage);

      // Sauvegarder la traduction dans le message
      translatedContent[targetLanguage] = translatedText;
      await query(
        'UPDATE public.messages SET translated_content = $1 WHERE id = $2',
        [JSON.stringify(translatedContent), messageId]
      );

      logger.info(`Message ${messageId} traduit en ${targetLanguage}`);

      return translatedText;
    } catch (error) {
      logger.error(`Erreur lors de la traduction du message ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Traduire plusieurs messages en batch
   */
  async translateMessages(messages, targetLanguage) {
    try {
      const translations = await Promise.all(
        messages.map(async (message) => {
          try {
            const translatedText = await this.translate(
              message.content || '',
              targetLanguage
            );
            
            return {
              messageId: message.id,
              originalText: message.content,
              translatedText,
              success: true,
            };
          } catch (error) {
            logger.error(`Erreur lors de la traduction du message ${message.id}:`, error);
            
            return {
              messageId: message.id,
              originalText: message.content,
              translatedText: null,
              success: false,
              error: error.message,
            };
          }
        })
      );

      return translations;
    } catch (error) {
      logger.error('Erreur lors de la traduction en batch:', error);
      throw error;
    }
  }

  /**
   * Détecter la langue d'un texte
   */
  async detectLanguage(text) {
    try {
      if (!this.apiKey || this.provider !== 'google') {
        // Retourner une détection simulée
        return this.detectLanguageMock(text);
      }

      const url = 'https://translation.googleapis.com/language/translate/v2/detect';
      
      const response = await axios.post(url, null, {
        params: {
          q: text,
          key: this.apiKey,
        },
        timeout: 5000,
      });

      if (response.data && response.data.data && response.data.data.detections) {
        const detection = response.data.data.detections[0][0];
        return {
          language: detection.language,
          confidence: detection.confidence,
          isReliable: detection.isReliable,
        };
      }

      throw new Error('Réponse invalide de Google Language Detection API');
    } catch (error) {
      logger.error('Erreur lors de la détection de langue:', error);
      return this.detectLanguageMock(text);
    }
  }

  /**
   * Détection de langue simulée
   */
  detectLanguageMock(text) {
    // Logique simple de détection basée sur des mots courants
    const textLower = text.toLowerCase();
    
    const languagePatterns = {
      fr: ['le', 'la', 'les', 'un', 'une', 'des', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles'],
      en: ['the', 'a', 'an', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'is', 'are', 'am'],
      es: ['el', 'la', 'los', 'las', 'un', 'una', 'yo', 'tú', 'él', 'ella', 'nosotros', 'vosotros', 'ellos', 'ellas'],
      de: ['der', 'die', 'das', 'ein', 'eine', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'sie'],
    };

    let bestMatch = { language: 'en', score: 0 };

    for (const [language, patterns] of Object.entries(languagePatterns)) {
      let score = 0;
      
      for (const pattern of patterns) {
        if (textLower.includes(pattern)) {
          score++;
        }
      }

      if (score > bestMatch.score) {
        bestMatch = { language, score };
      }
    }

    return {
      language: bestMatch.language,
      confidence: bestMatch.score / 10, // Score normalisé
      isReliable: bestMatch.score > 2,
    };
  }

  /**
   * Obtenir les langues supportées
   */
  getSupportedLanguages() {
    return config.constants.supportedLanguages.map(lang => ({
      code: lang,
      name: this.getLanguageName(lang),
      nativeName: this.getLanguageNativeName(lang),
    }));
  }

  /**
   * Obtenir le nom d'une langue
   */
  getLanguageName(languageCode) {
    const languageNames = {
      fr: 'French',
      en: 'English',
      es: 'Spanish',
      de: 'German',
      it: 'Italian',
      pt: 'Portuguese',
      ru: 'Russian',
      zh: 'Chinese',
      ja: 'Japanese',
      ko: 'Korean',
      ar: 'Arabic',
    };

    return languageNames[languageCode] || languageCode;
  }

  /**
   * Obtenir le nom natif d'une langue
   */
  getLanguageNativeName(languageCode) {
    const nativeNames = {
      fr: 'Français',
      en: 'English',
      es: 'Español',
      de: 'Deutsch',
      it: 'Italiano',
      pt: 'Português',
      ru: 'Русский',
      zh: '中文',
      ja: '日本語',
      ko: '한국어',
      ar: 'العربية',
    };

    return nativeNames[languageCode] || languageCode;
  }

  /**
   * Vider le cache des traductions
   */
  clearCache() {
    const deletedCount = translationCache.keys().length;
    translationCache.flushAll();
    logger.info(`Cache des traductions vidé: ${deletedCount} entrées supprimées`);
    return deletedCount;
  }

  /**
   * Obtenir les statistiques du cache
   */
  getCacheStats() {
    return translationCache.getStats();
  }
}

// Singleton pattern
const translationService = new TranslationService();

module.exports = translationService;