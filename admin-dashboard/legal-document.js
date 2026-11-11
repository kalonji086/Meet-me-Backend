(() => {
  const article = document.querySelector('[data-legal-type]');
  if (!article) return;

  const type = article.dataset.legalType;
  const toc = document.querySelector('[data-legal-toc]');
  const versionLabel = document.querySelector('[data-legal-version]');
  const defaultArticle = article.innerHTML;
  const defaultToc = toc?.innerHTML || '';
  const defaultVersion = versionLabel?.textContent || '';
  let lastRenderedDocument = '';

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  function plainTextToHtml(content) {
    return content.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (/^#{1,3}\s+/.test(trimmed)) {
        return `<h2>${escapeHtml(trimmed.replace(/^#{1,3}\s+/, ''))}</h2>`;
      }
      if (/^\d+(?:\.\d+)*[.)]?\s+.{1,110}$/.test(trimmed)) {
        return `<h2>${escapeHtml(trimmed)}</h2>`;
      }
      if (/^[•*-]\s+/.test(trimmed)) {
        return `<p>• ${escapeHtml(trimmed.replace(/^[•*-]\s+/, ''))}</p>`;
      }
      return `<p>${escapeHtml(trimmed)}</p>`;
    }).join('');
  }

  function sanitizeHtml(content) {
    const template = document.createElement('template');
    template.innerHTML = content;
    const allowedTags = new Set([
      'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI',
      'STRONG', 'B', 'EM', 'I', 'U', 'A', 'BR', 'BLOCKQUOTE', 'HR'
    ]);
    const ignoredTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH']);

    function copyNode(source, target) {
      if (source.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(source.textContent || ''));
        return;
      }
      if (source.nodeType !== Node.ELEMENT_NODE) return;

      const sourceElement = source;
      if (ignoredTags.has(sourceElement.tagName)) return;
      const tag = allowedTags.has(sourceElement.tagName) ? sourceElement.tagName.toLowerCase() : null;
      const destination = tag ? document.createElement(tag) : target;

      if (tag === 'a') {
        const href = sourceElement.getAttribute('href');
        if (href) {
          try {
            const url = new URL(href, window.location.origin);
            if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
              destination.setAttribute('href', url.href);
              destination.setAttribute('rel', 'noopener noreferrer');
            }
          } catch (error) {
            console.warn('Ignoring invalid link in published legal content.', error);
          }
        }
      }

      Array.from(sourceElement.childNodes).forEach(child => copyNode(child, destination));
      if (tag) target.appendChild(destination);
    }

    const safeFragment = document.createDocumentFragment();
    Array.from(template.content.childNodes).forEach(node => copyNode(node, safeFragment));
    return safeFragment;
  }

  function renderDocument(doc) {
    const content = String(doc.content || '').trim();
    if (!content || lastRenderedDocument === `${doc.version}:${content}`) return;

    article.replaceChildren();
    const hasHtml = /<\/?[a-z][^>]*>/i.test(content);
    article.appendChild(hasHtml ? sanitizeHtml(content) : sanitizeHtml(plainTextToHtml(content)));

    const headings = Array.from(article.querySelectorAll('h1, h2, h3, h4'));
    if (toc) {
      toc.replaceChildren();
      if (headings.length) {
        headings.forEach((heading, index) => {
          const id = `legal-section-${index + 1}`;
          heading.id = id;
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = `#${id}`;
          link.textContent = heading.textContent || `Section ${index + 1}`;
          item.appendChild(link);
          toc.appendChild(item);
        });
      } else {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#legal-document-top';
        link.textContent = 'Document complet';
        item.appendChild(link);
        toc.appendChild(item);
        article.id = 'legal-document-top';
      }
    }

    if (versionLabel) versionLabel.textContent = doc.version ? `Version ${doc.version}` : 'Version actuelle';
    lastRenderedDocument = `${doc.version}:${content}`;
  }

  function restoreDefaultDocument() {
    if (!lastRenderedDocument) return;
    article.innerHTML = defaultArticle;
    if (toc) toc.innerHTML = defaultToc;
    if (versionLabel) versionLabel.textContent = defaultVersion;
    article.removeAttribute('id');
    lastRenderedDocument = '';
  }

  async function refreshPublishedDocument() {
    if (document.visibilityState === 'hidden') return;
    try {
      const response = await fetch('/api/legal', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Legal documents request failed (${response.status}).`);
      const result = await response.json();
      const doc = Array.isArray(result.data) ? result.data.find(item => item.type === type) : null;
      if (!result.success) throw new Error('The legal documents response was unsuccessful.');
      if (!doc || !doc.content) {
        restoreDefaultDocument();
        return;
      }

      const isUneditedDefault = /^\s*(?:Conditions Générales d['’]Utilisation|Politique de Confidentialité)\s*-\s*Version\s+\S+\s*$/i.test(doc.content);
      if (isUneditedDefault) restoreDefaultDocument();
      else renderDocument(doc);
    } catch (error) {
      console.error(`Unable to refresh published ${type} document:`, error);
    }
  }

  refreshPublishedDocument();
  window.setInterval(refreshPublishedDocument, 30_000);
  document.addEventListener('visibilitychange', refreshPublishedDocument);
})();
