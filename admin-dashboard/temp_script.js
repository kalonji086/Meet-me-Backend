
        const API_BASE = '/api/portfolio';
        let socket, currentQuoteId = null, portfolioId = null, servicesData = [], currentCarouselIndex = 0, activePage = 'home', portfolioSlug = 'together', activeDiscordGroupId = null, mediaRecorder, audioChunks = [], enabledModules = [];

        // Visitor Identification
        if (!localStorage.getItem('visitor_id')) {
            localStorage.setItem('visitor_id', 'v_' + Math.random().toString(36).substr(2, 9));
        }
        const visitorId = localStorage.getItem('visitor_id');

        function toast(msg, type = "info") {
            const div = document.createElement('div');
            div.className = `fixed bottom-8 left-1/2 -translate-x-1/2 px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-2xl z-[10000] animate-pop-in ${type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`;
            div.innerText = msg;
            document.body.appendChild(div);
            setTimeout(() => {
                div.classList.replace('animate-pop-in', 'animate-fade-out');
                setTimeout(() => div.remove(), 500);
            }, 3000);
        }

        window.addEventListener('DOMContentLoaded', () => {
            const pathParts = window.location.pathname.split('/');
            if (pathParts.includes('p')) { portfolioSlug = pathParts[pathParts.indexOf('p') + 1]; }
            loadData();
            initSocket();
            lucide.createIcons();
            window.addEventListener('hashchange', handleRoute);
            handleRoute();
            window.addEventListener('scroll', () => {
                const nav = document.getElementById('navbar');
                if (window.scrollY > 50) nav.querySelector('.max-w-7xl').classList.add('bg-[#0a0a0c]/90', 'backdrop-blur-xl', 'py-3');
                else nav.querySelector('.max-w-7xl').classList.remove('bg-[#0a0a0c]/90', 'backdrop-blur-xl', 'py-3');
            });
            document.getElementById('discord-chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDiscordMessage(); });
            document.getElementById('quote-form')?.addEventListener('submit', submitQuoteForm);
        });

        function handleRoute() { const hash = window.location.hash.replace('#', '') || 'home'; navigateTo(hash, false); }

        function toggleMobileNav() {
            const nav = document.getElementById('mobile-nav');
            const icon = document.getElementById('menu-icon');
            const isOpen = !nav.classList.contains('hidden');
            if (isOpen) {
                nav.classList.add('hidden');
                icon.setAttribute('data-lucide', 'menu');
            } else {
                nav.classList.remove('hidden');
                nav.classList.add('flex');
                icon.setAttribute('data-lucide', 'x');
            }
            lucide.createIcons();
        }

        function toggleDiscordChannels() { document.getElementById('discord-channels-sidebar').classList.toggle('open'); }
        function toggleDiscordMembers() { document.getElementById('discord-member-list').classList.toggle('hidden'); }

        function navigateTo(pageId, updateHash = true) {
            if (pageId !== 'home' && pageId !== 'blog' && pageId !== 'blog-read' && pageId !== 'content' && pageId !== 'community' && enabledModules.length > 0 && !enabledModules.includes(pageId)) {
                toast('Ce module nâ€™est pas activÃ© pour ce portfolio', 'error');
                return;
            }
            document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
            const target = document.getElementById('page-' + pageId);
            if (target) {
                target.classList.add('active');
                target.style.display = (pageId === 'community') ? 'flex' : 'block';
                activePage = pageId;
                if (updateHash) window.location.hash = pageId;
                const isDiscord = pageId === 'community';
                document.getElementById('navbar').style.display = isDiscord ? 'none' : 'block';
                document.getElementById('global-footer').style.display = isDiscord ? 'none' : 'block';
                if (isDiscord) loadDiscordCommunity();
                window.scrollTo(0, 0);
            }
        }

        async function loadDiscordCommunity() {
            try {
                const res = await axios.get(`${API_BASE}/community/groups`);
                const { groups, announcements } = res.data.data;
                document.getElementById('discord-visitor-name').innerText = localStorage.getItem('visitor_name') || 'Visiteur';
                document.getElementById('discord-groups-list').innerHTML = groups.map(g => `<div id="discord-group-${escapeHtml(g.id)}" class="discord-server-icon flex items-center justify-center bg-white/5 text-gray-400 hover:bg-[#5865f2] hover:text-white group" onclick="selectDiscordGroup('${escapeHtml(g.id)}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')" title="${escapeHtml(g.name)}">${g.avatar_url ? `<img src="${getFullUrl(g.avatar_url)}" class="w-full h-full object-cover rounded-[inherit]">` : escapeHtml(g.name.charAt(0))}<span class="discord-tooltip">${escapeHtml(g.name)}</span></div>`).join('');
                document.getElementById('discord-channels-list').innerHTML = groups.map(g => `<div class="flex items-center px-2 py-1.5 rounded ${activeDiscordGroupId === g.id ? 'bg-white/10 text-white' : 'text-gray-400'} font-medium text-sm cursor-pointer hover:bg-white/5 transition-all group" onclick="selectDiscordGroup('${escapeHtml(g.id)}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')"><i data-lucide="hash" class="w-4 h-4 mr-2 text-gray-400"></i> ${escapeHtml(g.name.toLowerCase())}</div>`).join('');
                document.getElementById('discord-announcements-list').innerHTML = announcements.map(a => `<div class="px-2 py-2 rounded hover:bg-white/5 cursor-pointer transition-all border-l-2 border-transparent hover:border-cyan-500"><p class="text-[10px] font-black text-white truncate uppercase">${escapeHtml(a.title)}</p><p class="text-[8px] text-gray-500 line-clamp-1">${escapeHtml(a.content)}</p></div>`).join('') || '<p class="text-[9px] text-gray-600 text-center italic">Aucune annonce</p>';
                if (groups.length > 0 && !activeDiscordGroupId) { selectDiscordGroup(groups[0].id, groups[0].name); }
                loadDiscordMembersList();
                lucide.createIcons();
            } catch (e) { console.error('Community loading error:', e); toast('CommunautÃ© indisponible', 'error'); }
        }

        async function loadDiscordMembersList() {
            try {
                const membersRes = await axios.get(`${API_BASE}/community/members`);
                const members = membersRes.data.data;
                const onlineCount = members.filter(m => m.status === 'online').length;
                document.querySelector('#discord-member-list h5').innerText = `EN LIGNE â€” ${onlineCount}`;
                document.getElementById('discord-online-list').innerHTML = members.slice(0, 30).map(m => `<div class="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer group"><div class="relative shrink-0"><img src="${getFullUrl(m.avatar_url)}" class="w-8 h-8 rounded-full object-cover shadow-lg"><div class="absolute bottom-0 right-0 w-3 h-3 ${m.status === 'online' ? 'bg-green-500' : 'bg-gray-500'} rounded-full border-2 border-[#2b2d31]"></div></div><span class="text-sm font-medium ${m.status === 'online' ? 'text-gray-200' : 'text-gray-500'} group-hover:text-white truncate">${escapeHtml(m.full_name)}</span></div>`).join('');
            } catch (e) { console.error('Members loading error:', e); toast('Membres indisponibles', 'error'); }
        }

        async function selectDiscordGroup(id, name) {
            activeDiscordGroupId = id;
            document.querySelectorAll('.discord-server-icon').forEach(el => el.classList.remove('active'));
            document.getElementById('discord-group-' + id)?.classList.add('active');
            document.getElementById('active-group-title').innerText = String(name).toLowerCase();

            // Switch view based on group name (Social vs Chat)
            if (String(name).toLowerCase().includes('actualitÃ©') || String(name).toLowerCase().includes('feed')) {
                document.getElementById('social-feed-view').classList.remove('hidden');
                document.getElementById('chat-messages-view').classList.add('hidden');
                loadSocialPosts();
            } else {
                document.getElementById('social-feed-view').classList.add('hidden');
                document.getElementById('chat-messages-view').classList.remove('hidden');
                loadDiscordMessages(id);
            }

            if (window.innerWidth < 768) toggleDiscordChannels();
        }

        async function loadSocialPosts() {
            try {
                const res = await axios.get(`${API_BASE}/${portfolioSlug}/posts`);
                const posts = res.data.data;
                document.getElementById('social-posts-list').innerHTML = posts.map(p => `
                    <div class="bg-[#2b2d31] rounded-2xl border border-white/5 overflow-hidden shadow-xl animate-fade-in">
                        <div class="p-4 flex items-center gap-3 border-b border-white/5">
                            <div class="w-10 h-10 rounded-full bg-indigo-500 flex items-center justify-center font-black text-xs text-white">${escapeHtml(p.author_name).charAt(0)}</div>
                            <div>
                                <p class="text-sm font-black text-white">${escapeHtml(p.author_name)}</p>
                                <p class="text-[9px] text-gray-500 uppercase font-bold">${timeAgo(p.created_at)}</p>
                            </div>
                        </div>
                        <div class="p-5">
                            <p class="text-gray-300 text-sm leading-relaxed mb-4">${escapeHtml(p.content)}</p>
                            ${p.image_url ? `<img src="${getFullUrl(p.image_url)}" class="w-full rounded-xl mb-4 border border-white/5 shadow-lg">` : ''}
                        </div>
                        <div class="px-5 py-3 bg-black/10 flex items-center gap-6 border-t border-white/5">
                            <button onclick="likePost('${escapeHtml(p.id)}')" class="flex items-center gap-2 text-gray-400 hover:text-red-500 transition-all group">
                                <i data-lucide="heart" class="w-4 h-4 group-hover:fill-current"></i>
                                <span class="text-[10px] font-black">${p.likes_count}</span>
                            </button>
                            <button onclick="focusComment('${escapeHtml(p.id)}')" class="flex items-center gap-2 text-gray-400 hover:text-indigo-400 transition-all">
                                <i data-lucide="message-square" class="w-4 h-4"></i>
                                <span class="text-[10px] font-black">${p.comments_count}</span>
                            </button>
                        </div>
                    </div>
                `).join('') || '<div class="text-center py-20 opacity-30 uppercase font-black text-xs">Aucun poste pour le moment</div>';
                lucide.createIcons();
            } catch (e) { console.error('Posts loading error:', e); toast('Publications indisponibles', 'error'); }
        }

        // Secret Story Reveal Functions
        function revealSecret(type) {
            const box = document.getElementById('story-reveal-box');
            const iconEl = document.getElementById('reveal-icon');
            const titleEl = document.getElementById('reveal-title');
            const descEl = document.getElementById('reveal-desc');

            let icon = 'âš¡', title = '', desc = '';
            let fullText = window.togetherStoryText || "L'histoire de Together Tech se construit chaque jour Ã  travers le code.";

            if (type === 'origine') {
                icon = 'ðŸ”¬';
                title = "L'Ã‰tincelle Initiale";
                desc = "Ã€ l'origine, Together Tech n'Ã©tait qu'un laboratoire clandestin nÃ© pour fusionner la simplicitÃ© des rÃ©seaux de messagerie instantanÃ©e avec la robustesse des Ã©cosystÃ¨mes d'affaires. L'idÃ©e phare Ã©tait d'Ã©radiquer la frontiÃ¨re entre un client et son Ã©quipe de dÃ©veloppement. Un espace interconnectÃ© d'Ã©gal Ã  Ã©gal.";
            } else if (type === 'vision') {
                icon = 'ðŸ›¸';
                title = "Le Manifeste Cyber-Design";
                desc = "Notre code d'honneur stipule que l'interface utilisateur n'est pas un simple habillage, mais une expÃ©rience sensorielle. Chaque pixel insÃ©rÃ© doit inciter Ã  l'action. Nous combinons des structures de serveurs asynchrones avec des architectures lÃ©gÃ¨res en temps rÃ©el pour une vÃ©locitÃ© sans limite.";
            } else if (type === 'futur') {
                icon = 'ðŸ”®';
                title = "L'Ã‰toile Noire du DÃ©veloppement";
                desc = "Ce portfolio et les modules SaaS que vous explorez sont l'ossature d'une plateforme d'automatisation intelligente encore plus vaste. Les prochaines itÃ©rations dÃ©bloqueront des pipelines d'intelligence collective, oÃ¹ chaque utilisateur devient co-crÃ©ateur de modules. Le futur s'Ã©crit ensemble.";
            }

            // Append parts of database dynamic description safely if available
            if (fullText.length > 30) {
                desc += "<br><br><span class='text-xs text-cyan-500/80 uppercase font-black tracking-widest block border-t border-white/5 pt-3'>Note Contextuelle :</span> <span class='text-xs text-gray-400 italic'>" + fullText + "</span>";
            }

            iconEl.innerText = icon;
            titleEl.innerText = title;
            descEl.innerHTML = desc;

            box.classList.remove('hidden');
            box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            lucide.createIcons();
        }

        function closeSecret() {
            document.getElementById('story-reveal-box').classList.add('hidden');
        }

        async function createPost() {
            const content = document.getElementById('new-post-content').value.trim();
            if (!content) return;
            const visitorName = localStorage.getItem('visitor_name') || 'Visiteur';
            try {
                await axios.post(`${API_BASE}/community/posts`, { slug: portfolioSlug, content, authorName: visitorName });
                document.getElementById('new-post-content').value = "";
                loadSocialPosts();
            } catch (e) { alert("Erreur envoi poste"); }
        }

        async function likePost(postId) {
            try { await axios.post(`${API_BASE}/community/posts/${postId}/like`); loadSocialPosts(); } catch (e) {}
        }

        async function focusComment(postId) {
            const content = prompt("Votre commentaire :");
            if (!content) return;
            const visitorName = localStorage.getItem('visitor_name') || 'Visiteur';
            try {
                await axios.post(`${API_BASE}/community/posts/${postId}/comment`, { content, authorName: visitorName });
                loadSocialPosts();
            } catch (e) { alert("Erreur envoi commentaire"); }
        }

        async function requestLiveSupport() {
            const name = prompt("Votre Nom complet :");
            if (!name) return;
            const email = prompt("Votre Email :");
            if (!email) return;
            const msg = prompt("DÃ©crivez votre problÃ¨me :");
            if (!msg) return;

            try {
                await axios.post(`${API_BASE}/community/support`, { name, email, subject: "Support CommunautÃ©", message: msg });
                alert("Votre ticket a Ã©tÃ© crÃ©Ã© ! Un admin vous contactera sur " + email);
            } catch (e) { alert("Erreur crÃ©ation ticket"); }
        }

        function timeAgo(date) {
            const seconds = Math.floor((new Date() - new Date(date)) / 1000);
            if (seconds < 60) return "Ã€ l'instant";
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + "m";
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + "h";
            return Math.floor(hours / 24) + "j";
        }

        async function loadDiscordMessages(groupId) { try { const res = await axios.get(`${API_BASE}/community/groups/${groupId}/messages`); renderDiscordMessages(res.data.data); } catch (e) {} }

        function renderDiscordMessages(messages) {
            const list = document.getElementById('discord-messages-list');
            if (!list) return;
            list.innerHTML = messages.map(m => {
                const name = escapeHtml(m.sender_name || (m.metadata?.visitorName) || 'Visiteur');
                const avatar = m.sender_avatar ? getFullUrl(m.sender_avatar) : `https://ui-avatars.com/api/?name=${name}&background=random`;
                const date = new Date(m.created_at).toLocaleString();
                let contentHtml = `<p class="text-gray-300 text-sm leading-relaxed">${escapeHtml(m.content)}</p>`;
                if (m.type === 'audio') contentHtml = `<audio src="${getFullUrl(m.file_url)}" controls class="h-8 mt-2 opacity-80"></audio>`;
                if (m.type === 'document') contentHtml = `<a href="${getFullUrl(m.file_url)}" target="_blank" class="flex items-center gap-3 p-4 bg-black/20 rounded-xl border border-white/5 mt-2 hover:bg-black/40 transition-all"><i data-lucide="file" class="text-cyan-400"></i><div class="overflow-hidden"><p class="text-xs font-bold text-white truncate">${escapeHtml(m.file_name || 'Document')}</p><p class="text-[8px] text-gray-500 uppercase">Fichier</p></div></a>`;
                return `<div class="flex items-start gap-4 hover:bg-black/5 p-2 rounded-lg transition-all group ${m.is_pinned ? 'bg-cyan-500/5 border-l-2 border-cyan-500' : ''}"><img src="${avatar}" class="w-10 h-10 rounded-full bg-gray-700 shadow-xl shrink-0"><div class="flex-1 min-w-0"><div class="flex items-center gap-2 flex-wrap"><span class="font-bold text-white text-sm hover:underline cursor-pointer">${name}</span><span class="text-[10px] text-gray-400 font-medium">${date}</span>${m.is_pinned ? '<i data-lucide="pin" class="w-3 h-3 text-cyan-400"></i>' : ''}</div>${contentHtml}</div><div class="opacity-0 group-hover:opacity-100 transition-all flex gap-2 shrink-0"><button onclick="togglePin('${escapeHtml(m.id)}', ${!m.is_pinned})" class="p-1 hover:bg-white/10 rounded"><i data-lucide="pin" class="w-4 h-4 text-gray-400"></i></button></div></div>`;
            }).join('');
            const container = document.getElementById('discord-messages-container');
            if (container) container.scrollTop = container.scrollHeight;
            lucide.createIcons();
        }

        async function sendDiscordMessage() {
            const input = document.getElementById('discord-chat-input');
            const content = input.value.trim();
            if (!content || !activeDiscordGroupId) return;
            try {
                const visitorName = localStorage.getItem('visitor_name') || 'Visiteur_' + Math.floor(Math.random() * 1000);
                if (!localStorage.getItem('visitor_name')) localStorage.setItem('visitor_name', visitorName);
                await axios.post(`${API_BASE}/community/groups/${activeDiscordGroupId}/messages`, { content, visitorName });
                input.value = '';
                loadDiscordMessages(activeDiscordGroupId);
            } catch (e) {}
        }

        async function sendSticker(sticker) {
            document.getElementById('sticker-picker').classList.add('hidden');
            const visitorName = localStorage.getItem('visitor_name') || 'Visiteur';
            await axios.post(`${API_BASE}/community/groups/${activeDiscordGroupId}/messages`, { content: sticker, visitorName, type: 'sticker' });
            loadDiscordMessages(activeDiscordGroupId);
        }

        async function uploadDiscordFile(input) {
            const file = input.files[0];
            if (!file || !activeDiscordGroupId) return;
            try {
                const formData = new FormData();
                formData.append('file', file);
                const upRes = await axios.post(`${API_BASE}/upload-public`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
                await axios.post(`${API_BASE}/community/groups/${activeDiscordGroupId}/messages`, { visitorName: localStorage.getItem('visitor_name') || 'Visiteur', type: 'document', fileUrl: upRes.data.data.fileUrl, fileName: file.name });
                loadDiscordMessages(activeDiscordGroupId);
            } catch (e) { alert("Erreur upload"); }
        }

        async function toggleAudioRecording() {
            const btn = document.getElementById('audio-record-btn');
            if (document.getElementById('discord-mic-btn').classList.contains('muted')) { alert("Micro dÃ©sactivÃ©."); return; }
            if (!mediaRecorder || mediaRecorder.state === 'inactive') {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    mediaRecorder = new MediaRecorder(stream);
                    audioChunks = [];
                    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
                    mediaRecorder.onstop = async () => {
                        const blob = new Blob(audioChunks, { type: 'audio/ogg' });
                        const formData = new FormData();
                        formData.append('file', new File([blob], "voice.ogg", { type: 'audio/ogg' }));
                        const upRes = await axios.post('/api/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
                        await axios.post(`${API_BASE}/community/groups/${activeDiscordGroupId}/messages`, { visitorName: localStorage.getItem('visitor_name') || 'Visiteur', type: 'audio', fileUrl: upRes.data.data.fileUrl });
                        loadDiscordMessages(activeDiscordGroupId);
                    };
                    mediaRecorder.start();
                    btn.classList.add('text-red-500', 'animate-pulse');
                } catch (e) { alert("Micro refusÃ©"); }
            } else { mediaRecorder.stop(); btn.classList.remove('text-red-500', 'animate-pulse'); }
        }

        async function togglePin(msgId, isPinned) { await axios.put(`${API_BASE}/community/messages/${msgId}/pin`, { isPinned }); loadDiscordMessages(activeDiscordGroupId); }
        function togglePinnedMessages() { document.getElementById('pinned-messages-panel').classList.toggle('hidden'); }

        function initSocket() {
            if (typeof io === 'undefined') return;
            socket = io();
            socket.on('community:new_message', (msg) => { if (activeDiscordGroupId === msg.chat_id) loadDiscordMessages(activeDiscordGroupId); });
            socket.on('community:new_post', (post) => { if (activePage === 'community') loadSocialPosts(); });
            socket.on('community:post_liked', (data) => { if (activePage === 'community') loadSocialPosts(); });
            socket.on('community:new_comment', (data) => { if (activePage === 'community') loadSocialPosts(); });
            socket.on('blog:post_liked', (data) => {
                const likesEl = document.getElementById('article-likes');
                if (likesEl && document.getElementById('page-blog-read').classList.contains('active')) {
                    // Only update if reading THAT specific post
                    likesEl.innerText = data.likes;
                } else if (activePage === 'blog') {
                    loadBlogData();
                }
            });
            socket.on('blog:new_comment', (data) => {
                if (document.getElementById('page-blog-read').classList.contains('active')) {
                    loadArticleComments(data.postId);
                } else if (activePage === 'blog') {
                    loadBlogData();
                }
            });
            socket.on('portfolio:data_updated', (data) => { if (data.portfolioId === '00000000-0000-0000-0000-000000000000' || portfolioSlug === 'together') loadData(); });
            socket.on('admin_user_login', () => loadDiscordMembersList());
            socket.on('admin_user_logout', () => loadDiscordMembersList());
        }

        async function loadData() {
            try {
                const res = await axios.get(`${API_BASE}/${portfolioSlug}/public`);
                const { skills, experiences, services, team, profile, pages, config } = res.data.data || {};
                if (config) {
                    portfolioId = config.id || null;
                    document.title = config.title;
                    if (config.theme_color) document.documentElement.style.setProperty('--primary-color', config.theme_color);

                    const brandName = document.getElementById('brand-name');
                    if (brandName) brandName.innerText = config.title;

                    const footerBrandName = document.getElementById('footer-brand-name');
                    if (footerBrandName) footerBrandName.innerText = config.title;

                    const createSaasBtn = document.getElementById('btn-create-saas');
                    if (createSaasBtn) createSaasBtn.classList.toggle('hidden', portfolioSlug !== 'together');

                    if (config.enabled_modules) {
                        let enabledList = config.enabled_modules;
                        if (typeof enabledList === 'string' && enabledList.startsWith('{')) {
                            enabledList = enabledList.replace(/[{}]/g, '').split(',');
                        }
                        if (!Array.isArray(enabledList)) enabledList = [];
                        enabledModules = enabledList.map(module => String(module).trim()).filter(Boolean);

                        document.querySelectorAll('[data-module]').forEach(btn => {
                            const mod = btn.getAttribute('data-module');
                            btn.classList.toggle('hidden', !enabledModules.includes(mod));
                        });
                    }
                }

                if (Array.isArray(skills)) renderSkills(skills);
                if (Array.isArray(experiences)) renderExperiences(experiences);
                if (Array.isArray(services)) renderServices(services);
                if (Array.isArray(team)) renderTeam(team);

                renderProfile(profile);
                renderFooterPages(pages, profile);

                loadBlogData();
                lucide.createIcons();
            } catch (e) {
                console.error("Load Data Error:", e);
                if (e.response?.status === 404) document.body.innerHTML = '<div class="h-screen flex items-center justify-center flex-col space-y-4"><h1>404 - Portfolio Non TrouvÃ©</h1><button onclick="location.href=\'/portfolio\'">Retour</button></div>';
            }
        }

        function renderFooterPages(pages, profile) {
            const list = document.getElementById('footer-pages-list');
            const resList = document.getElementById('footer-resources-list');
            if (list && Array.isArray(pages)) list.innerHTML = pages.map(p => `<li><button onclick="viewGenericPage('${p.slug}')" class="hover:text-cyan-400 uppercase">${p.title}</button></li>`).join('');
            if (resList) resList.innerHTML = `<li><button onclick="navigateTo('blog')" class="hover:text-cyan-400 uppercase">Le Blog</button></li><li><button onclick="navigateTo('community')" class="hover:text-cyan-400 uppercase">CommunautÃ©s</button></li>`;
        }

        async function viewGenericPage(slug) {
            try {
                const res = await axios.get(`${API_BASE}/${portfolioSlug}/public`);
                const pages = res.data.data?.pages || [];
                const page = pages.find(p => p.slug === slug);
                if (page) {
                    document.getElementById('generic-page-title').innerText = page.title;

                    // Transformation du contenu brut HTML de la politique ou des conditions en Ã©tapes interactives animÃ©es si applicable
                    let contentHTML = page.content;

                    // Si le contenu comporte des paragraphes ou des listes, on le segmente pour crÃ©er une frise d'Ã©tapes captivante
                    if (contentHTML && (contentHTML.includes('<p>') || contentHTML.includes('<li>') || contentHTML.includes('<h3>') || contentHTML.includes('<h4>'))) {
                        // CrÃ©er un conteneur temporaire pour analyser le DOM gÃ©nÃ©rÃ© par l'admin
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = contentHTML;

                        // Extraire tous les blocs textuels significatifs (titres h3/h4, paragraphes, Ã©lÃ©ments de listes)
                        const nodes = Array.from(tempDiv.querySelectorAll('h3, h4, p, li'));
                        let steps = [];
                        let currentStepTitle = page.title;
                        let currentStepTexts = [];

                        nodes.forEach((node, index) => {
                            const text = node.innerText.trim();
                            if (!text) return;

                            if (node.tagName === 'H3' || node.tagName === 'H4' || text.length < 50 && (text.includes('.') || text.endsWith(':'))) {
                                if (currentStepTexts.length > 0) {
                                    steps.push({ title: currentStepTitle, content: currentStepTexts.join('<br><br>') });
                                    currentStepTexts = [];
                                }
                                currentStepTitle = text;
                            } else {
                                currentStepTexts.push(text);
                            }
                        });

                        if (currentStepTexts.length > 0) {
                            steps.push({ title: currentStepTitle, content: currentStepTexts.join('<br><br>') });
                        }

                        // Si on a rÃ©ussi Ã  extraire des Ã©tapes, on gÃ©nÃ¨re une timeline animÃ©e interactive
                        if (steps.length > 0) {
                            contentHTML = `
                                <div class="space-y-12 relative before:absolute before:inset-0 before:left-6 md:before:left-12 before:w-[2px] before:bg-gradient-to-b before:from-cyan-500 before:via-purple-500 before:to-transparent before:opacity-20">
                                    ${steps.map((step, idx) => `
                                        <div class="relative pl-14 md:pl-24 group animate-pageIn" style="animation-delay: ${idx * 0.1}s">
                                            <!-- Badge d'Ã©tape NumÃ©rique et Lumineux -->
                                            <div class="absolute left-2 md:left-6 top-0 w-8 h-8 md:w-12 md:h-12 rounded-2xl bg-gradient-to-tr from-cyan-500/10 to-purple-500/10 border border-white/5 group-hover:border-cyan-500/50 flex items-center justify-center font-black text-xs md:text-sm text-cyan-400 group-hover:text-white group-hover:from-cyan-500 group-hover:to-purple-500 shadow-2xl transition-all duration-300 z-10 select-none">
                                                ${String(idx + 1).padStart(2, '0')}
                                            </div>

                                            <!-- Conteneur de l'Ã©tape -->
                                            <div class="glass p-6 md:p-10 rounded-3xl border border-white/5 group-hover:border-white/10 transition-all duration-300 bg-white/[0.01] hover:bg-white/[0.02] shadow-xl hover:shadow-2xl">
                                                <h4 class="text-lg md:text-2xl font-black uppercase tracking-tight text-white mb-4 group-hover:text-cyan-400 transition-all flex items-center gap-2">
                                                    <i data-lucide="shield-check" class="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-all"></i> ${step.title}
                                                </h4>
                                                <p class="text-gray-400 group-hover:text-gray-300 text-sm md:text-base leading-relaxed font-medium transition-all">${step.content}</p>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            `;
                        }
                    }

                    document.getElementById('generic-page-body').innerHTML = contentHTML;
                    navigateTo('content');
                    lucide.createIcons();
                }
            } catch (e) {
                console.error("Generic page parsing error:", e);
            }
        }
        function renderTeam(team) {
            document.getElementById('team-grid').innerHTML = team.map(m => `
                <div class="team-card rounded-[2.2rem] md:rounded-[3.7rem]">
                    <div class="team-card-inner group flex flex-col items-center p-6 md:p-10 rounded-[2rem] md:rounded-[3.5rem]">
                        <div class="relative w-full aspect-[3/4] rounded-[1.5rem] md:rounded-[3rem] overflow-hidden glass mb-4 sm:mb-8">
                            <img src="${getFullUrl(m.image_url)}" class="w-full h-full object-cover transition-all group-hover:scale-110">
                            <div class="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] to-transparent opacity-80"></div>
                            <div class="absolute bottom-4 left-4 md:bottom-8 md:left-8 right-4 md:right-8">
                                <p class="text-[8px] md:text-[10px] font-black text-cyan-400 uppercase tracking-widest">${escapeHtml(m.role)}</p>
                                <h4 class="text-xl md:text-3xl font-black text-white uppercase truncate">${escapeHtml(m.name)}</h4>
                            </div>
                        </div>
                        <p class="text-gray-500 text-xs text-center line-clamp-2">${escapeHtml(m.bio || '')}</p>
                    </div>
                </div>`).join('');
        }
        function renderSkills(skills) {
            document.getElementById('skills-grid').innerHTML = skills.map(s => `
                <div class="glass p-8 md:p-12 rounded-[2.5rem] md:rounded-[3.5rem] border-white/5 hover:border-cyan-500/40 transition-all hover:scale-[1.02] group relative overflow-hidden text-left flex flex-col h-full">
                    <div class="flex justify-between items-start mb-8">
                        <div class="w-16 h-16 md:w-20 md:h-20 bg-white rounded-2xl flex items-center justify-center overflow-hidden border border-white/10 shadow-2xl shrink-0">
                            ${s.image_url ? `<img src="${getFullUrl(s.image_url)}" class="w-full h-full object-cover">` : `<i data-lucide="zap" class="w-8 h-8 text-cyan-400"></i>`}
                        </div>
                        <div class="text-right">
                            <span class="block text-[10px] md:text-xs font-black text-gray-600 uppercase tracking-widest">${s.level}% MaÃ®trise</span>
                            <span class="block text-[8px] font-black text-cyan-500 uppercase mt-1 tracking-tighter">${s.years_experience || 1} ans d'XP</span>
                        </div>
                    </div>
                    <h4 class="font-black text-lg md:text-2xl uppercase text-white mb-4 tracking-tighter italic">${escapeHtml(s.name)}</h4>
                    <p class="text-gray-400 text-sm md:text-base font-medium leading-relaxed italic mb-8 flex-1">"${escapeHtml(s.description || 'Expertise confirmÃ©e dans le dÃ©veloppement et l\'optimisation...')}"</p>
                    <div class="w-full h-1 md:h-1.5 bg-white/5 rounded-full mt-auto overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-cyan-500 to-indigo-500" style="width: ${s.level}%"></div>
                    </div>
                </div>`).join('');
        }

        async function loadBlogData() {
            try {
                const res = await axios.get(`${API_BASE}/${portfolioSlug}/blog`);
                const posts = res.data.data;
                renderBlogPosts(posts);
            } catch (e) {}
        }

        function renderBlogPosts(posts) {
            const grid = document.getElementById('blog-posts-grid');
            if (!grid) return;
            grid.innerHTML = posts.map(p => `
                <div class="glass rounded-[2.5rem] overflow-hidden group hover:scale-[1.02] transition-all flex flex-col h-full border-white/5">
                    <div class="relative h-64 overflow-hidden">
                        <img src="${getFullUrl(p.image_url)}" class="w-full h-full object-cover transition-all group-hover:scale-110">
                        <div class="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] to-transparent"></div>
                        <span class="absolute top-6 left-6 px-4 py-1 bg-white/10 backdrop-blur-md text-white text-[8px] font-black uppercase tracking-[0.2em] rounded-lg border border-white/10">${p.theme}</span>
                    </div>
                    <div class="p-8 flex flex-col flex-1 text-left">
                        <h4 class="text-2xl font-black text-white uppercase tracking-tighter leading-tight mb-4">${p.title}</h4>
                        <p class="text-gray-500 text-xs font-bold uppercase mb-8">${new Date(p.created_at).toLocaleDateString()}</p>

                        <div class="flex items-center justify-between mt-auto">
                            <div class="flex items-center gap-4 text-gray-400">
                                <span class="flex items-center gap-1.5 text-[10px] font-black"><i data-lucide="heart" class="w-3.5 h-3.5"></i> ${p.likes_count}</span>
                                <span class="flex items-center gap-1.5 text-[10px] font-black"><i data-lucide="message-square" class="w-3.5 h-3.5"></i> ${p.comments_count}</span>
                            </div>
                            <button onclick="readBlogPost('${p.slug}')" class="px-6 py-2.5 bg-white text-black rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-cyan-500 hover:text-white transition-all">Lire l'article</button>
                        </div>
                    </div>
                </div>
            `).join('');
            lucide.createIcons();
        }

        function formatBlogContentSteps(content) {
            let contentText = content || "";
            if (!contentText.includes('<p>') && !contentText.includes('<br>')) {
                contentText = contentText.split('\n\n').map(p => `<p>${p}</p>`).join('');
            }
            const parser = new DOMParser();
            const doc = parser.parseFromString(`<div>${contentText}</div>`, 'text/html');
            const paragraphs = Array.from(doc.body.firstChild.children).filter(el => el.innerText.trim().length > 0);

            if (paragraphs.length > 1) {
                return paragraphs.map((p, pIdx) => `
                    <div class="relative pl-12 md:pl-20 group animate-pageIn" style="animation-delay: ${pIdx * 0.15}s">
                        <div class="absolute left-0 top-1 w-6 h-6 md:w-8 md:h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 font-black text-[10px] md:text-xs flex items-center justify-center group-hover:bg-cyan-500 group-hover:text-white transition-all select-none">
                            ${String(pIdx + 1).padStart(2, '0')}
                        </div>
                        <div class="text-gray-300 group-hover:text-white transition-all duration-300">
                            ${p.outerHTML}
                        </div>
                    </div>
                `).join('');
            }
            return contentText;
        }

        async function readBlogPost(slug) {
            try {
                // Prevent scrolling to top before transition
                const res = await axios.get(`${API_BASE}/${portfolioSlug}/blog`);
                const post = res.data.data.find(p => p.slug === slug);
                if (!post) return;

                if (post.is_external && post.external_url) {
                    window.open(post.external_url, '_blank');
                    return;
                }

                // Render Article View
                const container = document.getElementById('blog-article-container');
                const formattedDate = new Date(post.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

                container.innerHTML = `
                    <div class="animate-pageIn">
                        <button onclick="navigateTo('blog')" class="flex items-center gap-3 text-gray-500 font-black text-[10px] uppercase tracking-widest hover:text-white transition-all mb-12">
                            <i data-lucide="arrow-left" class="w-4 h-4"></i> Retour Ã  la liste
                        </button>

                        <div class="relative w-full h-[250px] sm:h-[500px] rounded-[2.5rem] sm:rounded-[4rem] overflow-hidden shadow-2xl mb-16 border border-white/5">
                            <img src="${getFullUrl(post.image_url)}" class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-gradient-to-t from-[#0a0a0c] via-transparent to-transparent"></div>
                            <div class="absolute bottom-8 left-8 sm:bottom-12 sm:left-12">
                                <span class="px-4 py-1.5 bg-cyan-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest shadow-xl">${post.theme}</span>
                            </div>
                        </div>

                        <div class="max-w-3xl mx-auto">
                            <p class="text-cyan-400 font-black text-[10px] uppercase tracking-[0.3em] mb-4">${formattedDate}</p>
                            <h1 class="text-4xl sm:text-7xl font-black text-white uppercase tracking-tighter leading-[0.85] mb-12">${post.title}</h1>

                            <div class="text-gray-400 leading-relaxed font-medium mb-20 text-base sm:text-xl space-y-8">
                                ${formatBlogContentSteps(post.content)}
                            </div>

                            ${post.cta_text ? `
                                <div class="p-10 sm:p-20 glass rounded-[3rem] sm:rounded-[5rem] border-white/10 text-center mb-32 relative overflow-hidden">
                                    <div class="absolute -top-10 -right-10 w-40 h-40 bg-cyan-500/10 blur-[80px] rounded-full"></div>
                                    <h4 class="text-2xl font-black text-white uppercase mb-10 tracking-tighter italic">PrÃªt Ã  transformer votre vision ?</h4>
                                    <a href="${post.cta_url}" target="_blank" class="inline-block px-12 py-5 bg-white text-black rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-cyan-500 hover:text-white transition-all shadow-2xl scale-110">
                                        ${post.cta_text}
                                    </a>
                                </div>
                            ` : ''}

                            <div id="blog-social-section" class="pt-20 border-t border-white/5">
                                <div class="flex items-center justify-between mb-16">
                                    <h3 class="text-3xl font-black text-white uppercase italic">Commentaires</h3>
                                    <button onclick="likeArticle('${post.id}')" class="flex items-center gap-3 px-8 py-3 glass rounded-full font-black text-[10px] uppercase hover:bg-red-500/20 hover:text-red-500 transition-all group">
                                        <i data-lucide="heart" class="w-4 h-4 group-hover:fill-current"></i>
                                        <span id="article-likes">${post.likes_count}</span>
                                    </button>
                                </div>

                                <div class="space-y-12 mb-20" id="article-comments">
                                    <div class="text-center py-10 opacity-20 uppercase font-black text-[10px] tracking-widest">Chargement...</div>
                                </div>

                                <div class="bg-white/[0.02] p-8 sm:p-12 rounded-[3rem] border border-white/5 relative">
                                    <div id="reply-info" class="hidden mb-6 p-5 bg-cyan-500/10 rounded-2xl border border-cyan-500/20 flex justify-between items-center">
                                        <p class="text-[10px] font-black text-cyan-400 uppercase">RÃ©ponse Ã  <span id="reply-target-name" class="text-white underline"></span></p>
                                        <button onclick="cancelReply()" class="text-gray-500 hover:text-white"><i data-lucide="x" class="w-4 h-4"></i></button>
                                    </div>

                                    <div id="blog-comment-file-preview" class="hidden mb-6 relative group w-40 h-40 rounded-2xl overflow-hidden border border-white/10">
                                        <img src="" id="blog-comment-img-preview" class="w-full h-full object-cover">
                                        <button onclick="clearBlogCommentFile()" class="absolute top-2 right-2 p-2 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all"><i data-lucide="x" class="w-4 h-4"></i></button>
                                    </div>

                                    <div id="blog-comment-sticker-preview" class="hidden mb-6 relative group w-32 h-32 rounded-2xl overflow-hidden border border-white/10 flex items-center justify-center bg-white/5">
                                        <span id="blog-comment-sticker-img" class="text-6xl"></span>
                                        <button onclick="clearBlogCommentSticker()" class="absolute top-2 right-2 p-2 bg-black/60 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all"><i data-lucide="x" class="w-4 h-4"></i></button>
                                    </div>

                                    <textarea id="comment-input" rows="5" placeholder="Votre avis nous intÃ©resse..." class="w-full bg-transparent border-none outline-none text-white font-medium text-lg mb-8 resize-none" style="min-height: 150px;"></textarea>

                                    <div id="blog-emoji-picker" class="hidden absolute bottom-24 left-8 z-[200] bg-[#1e1f22] p-4 rounded-2xl border border-white/10 shadow-2xl max-h-48 overflow-y-auto custom-scrollbar w-64">
                                        <div class="grid grid-cols-6 gap-2">
                                            ${['ðŸ˜€','ðŸ˜‚','ðŸ¥°','ðŸ˜Ž','ðŸ¤”','ðŸ”¥','ðŸš€','ðŸ’¯','ðŸ™','ðŸ‘','â¤ï¸','âœ¨','ðŸŽ‰','ðŸ’Ž','ðŸ‘‘','ðŸ’ª','ðŸ¤','ðŸ“±','ðŸ’»','âš¡','ðŸŒŸ','ðŸŒ'].map(e => `<button onclick="addEmojiToComment('${e}')" class="text-xl hover:bg-white/5 p-1 rounded">${e}</button>`).join('')}
                                        </div>
                                    </div>

                                    <div id="blog-sticker-picker" class="hidden absolute bottom-24 left-24 z-[200] bg-[#1e1f22] p-4 rounded-2xl border border-white/10 shadow-2xl max-h-48 overflow-y-auto custom-scrollbar w-64">
                                        <div class="grid grid-cols-4 gap-3 text-center">
                                            ${['ðŸš€','ðŸ”¥','ðŸŽ‰','ðŸ’¯','â¤ï¸','ðŸ˜Ž','ðŸ‘‘','âœ¨','ðŸ‘','ðŸ˜','ðŸ¤©','ðŸ’¥','ðŸŽˆ','ðŸ†','ðŸ’¡','ðŸ¤–','ðŸŽ®','ðŸŽµ','ðŸŒŸ','ðŸ¦¾'].map(s => `<button onclick="selectBlogSticker('${s}')" class="text-3xl hover:bg-white/5 p-2 rounded transition-all transform hover:scale-110">${s}</button>`).join('')}
                                        </div>
                                    </div>

                                    <div class="flex justify-between items-center">
                                        <div class="flex gap-4 text-gray-400">
                                            <button onclick="document.getElementById('blog-emoji-picker').classList.toggle('hidden'); document.getElementById('blog-sticker-picker').classList.add('hidden');" class="hover:text-cyan-400 transition-all"><i data-lucide="smile" class="w-5 h-5"></i></button>
                                            <button onclick="document.getElementById('blog-sticker-picker').classList.toggle('hidden'); document.getElementById('blog-emoji-picker').classList.add('hidden');" class="hover:text-cyan-400 transition-all"><i data-lucide="sticky-note" class="w-5 h-5"></i></button>
                                            <button onclick="document.getElementById('blog-comment-file').click()" class="hover:text-cyan-400 transition-all"><i data-lucide="image" class="w-5 h-5"></i></button>
                                            <input type="file" id="blog-comment-file" class="hidden" onchange="previewBlogCommentFile(this)">
                                        </div>
                                        <input type="hidden" id="reply-parent-id">
                                        <input type="hidden" id="blog-sticker-input">
                                        <button onclick="postComment('${post.id}')" class="px-12 py-5 bg-cyan-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-2xl hover:scale-105 transition-all">Envoyer</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                navigateTo('blog-read');
                lucide.createIcons();
                loadArticleComments(post.id);
            } catch (e) {
                console.error("Read Blog Error:", e);
                toast("Erreur chargement article", "error");
            }
        }

        async function loadArticleComments(postId) {
            try {
                const res = await axios.get(`${API_BASE}/blog/posts/${postId}/comments`);
                const comments = res.data.data;
                const container = document.getElementById('article-comments');

                if (comments.length === 0) {
                    container.innerHTML = '<div class="text-center py-10 opacity-30 uppercase font-black text-[10px]">Soyez le premier Ã  commenter !</div>';
                    return;
                }

                // Simple flat list for now, or recursive for nesting
                container.innerHTML = comments.filter(c => !c.parent_id).map(c => renderCommentHtml(c, comments)).join('');
                lucide.createIcons();
            } catch (e) {}
        }

        function renderCommentHtml(comment, allComments) {
            const replies = allComments.filter(r => r.parent_id === comment.id);
            const authorName = escapeHtml(comment.author_name);
            const avatar = comment.author_avatar ? getFullUrl(comment.author_avatar) : `https://ui-avatars.com/api/?name=${authorName}&background=random`;

            return `
                <div class="space-y-6">
                    <div class="flex gap-4 sm:gap-6 group">
                        <img src="${avatar}" class="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl object-cover shadow-xl shrink-0">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-3 mb-2">
                                <h5 class="font-black text-white text-sm uppercase truncate">${authorName}</h5>
                                <span class="text-[9px] text-gray-500 font-bold uppercase">${timeAgo(comment.created_at)}</span>
                            </div>
                            <p class="text-gray-400 text-sm leading-relaxed">${escapeHtml(comment.content)}</p>
                            ${comment.sticker_url ? `
                                <div class="mt-3 text-5xl filter drop-shadow-md transform hover:scale-110 transition-all select-none">
                                    ${escapeHtml(comment.sticker_url)}
                                </div>
                            ` : ''}
                            ${comment.image_url ? `
                                <div class="mt-4 w-full max-w-sm rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
                                    <img src="${getFullUrl(comment.image_url)}" class="w-full h-auto object-cover">
                                </div>
                            ` : ''}
                            <button onclick="prepareReply('${escapeHtml(comment.id)}', '${authorName.replace(/'/g, "\\'")}')" class="mt-3 text-[9px] font-black text-cyan-400 uppercase tracking-widest hover:underline opacity-0 group-hover:opacity-100 transition-all">RÃ©pondre</button>
                        </div>
                    </div>
                    ${replies.length > 0 ? `
                        <div class="ml-10 sm:ml-16 pl-6 border-l border-white/5 space-y-8">
                            ${replies.map(r => renderCommentHtml(r, allComments)).join('')}
                        </div>
                    ` : ''}
                </div>
            `;
        }

        function prepareReply(parentId, authorName) {
            document.getElementById('reply-parent-id').value = parentId;
            document.getElementById('reply-target-name').innerText = authorName;
            document.getElementById('reply-info').classList.remove('hidden');
            document.getElementById('comment-input').focus();
            document.getElementById('comment-input').placeholder = "Votre rÃ©ponse Ã  " + authorName + "...";
        }

        function cancelReply() {
            document.getElementById('reply-parent-id').value = '';
            document.getElementById('reply-info').classList.add('hidden');
            document.getElementById('comment-input').placeholder = "Votre commentaire...";
        }

        async function likeArticle(postId) {
            try {
                await axios.post(`${API_BASE}/blog/posts/${postId}/like`, { visitorId });
                const likesEl = document.getElementById('article-likes');
                if (likesEl) likesEl.innerText = parseInt(likesEl.innerText) + 1;
                toast("AjoutÃ© aux favoris", "success");
            } catch (e) {}
        }

        function addEmojiToComment(emoji) {
            document.getElementById('comment-input').value += emoji;
            document.getElementById('blog-emoji-picker').classList.add('hidden');
        }

        function previewBlogCommentFile(input) {
            if (input.files && input.files[0]) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    document.getElementById('blog-comment-img-preview').src = e.target.result;
                    document.getElementById('blog-comment-file-preview').classList.remove('hidden');
                };
                reader.readAsDataURL(input.files[0]);
            }
        }

        function clearBlogCommentFile() {
            document.getElementById('blog-comment-file').value = '';
            document.getElementById('blog-comment-file-preview').classList.add('hidden');
        }

        function selectBlogSticker(sticker) {
            document.getElementById('blog-sticker-input').value = sticker;
            document.getElementById('blog-comment-sticker-img').innerText = sticker;
            document.getElementById('blog-comment-sticker-preview').classList.remove('hidden');
            document.getElementById('blog-sticker-picker').classList.add('hidden');
        }

        function clearBlogCommentSticker() {
            document.getElementById('blog-sticker-input').value = '';
            document.getElementById('blog-comment-sticker-preview').classList.add('hidden');
        }

        async function postComment(postId) {
            const content = document.getElementById('comment-input').value.trim();
            const fileInput = document.getElementById('blog-comment-file');
            const stickerInput = document.getElementById('blog-sticker-input');
            const stickerUrl = stickerInput ? stickerInput.value : '';

            if (!content && !fileInput.files[0] && !stickerUrl) return;

            const visitorName = localStorage.getItem('visitor_name') || 'Visiteur';
            const parentId = document.getElementById('reply-parent-id').value;

            try {
                let imageUrl = null;
                if (fileInput.files[0]) {
                    const formData = new FormData();
                    formData.append('file', fileInput.files[0]);
                    const upRes = await axios.post(`${API_BASE}/upload-public`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
                    imageUrl = upRes.data.data.fileUrl;
                }

                await axios.post(`${API_BASE}/blog/posts/${postId}/comment`, {
                    content,
                    authorName: visitorName,
                    visitorId: visitorId,
                    parentId: parentId || null,
                    imageUrl: imageUrl,
                    stickerUrl: stickerUrl || null
                });

                document.getElementById('comment-input').value = "";
                clearBlogCommentFile();
                clearBlogCommentSticker();
                cancelReply();
                loadArticleComments(postId);
                toast("Commentaire envoyÃ©", "success");
            } catch (e) { alert("Erreur lors de l'envoi"); }
        }
        function renderExperiences(exps) {
            document.getElementById('experience-timeline').innerHTML = exps.map((e) => {
                let statusBadge = "";
                if (e.is_in_progress) {
                    statusBadge = `<span class="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/20 text-amber-400 rounded-lg text-[8px] font-black uppercase tracking-widest border border-amber-500/20"><i data-lucide="clock" class="w-2.5 h-2.5"></i> En cours</span>`;
                } else {
                    if (e.project_status === 'beta') {
                        statusBadge = `<span class="flex items-center gap-1.5 px-2.5 py-1 bg-purple-500/20 text-purple-400 rounded-lg text-[8px] font-black uppercase tracking-widest border border-purple-500/20"><i data-lucide="beaker" class="w-2.5 h-2.5"></i> BÃªta Test</span>`;
                    } else if (e.project_status === 'concept') {
                        statusBadge = `<span class="flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/20 text-blue-400 rounded-lg text-[8px] font-black uppercase tracking-widest border border-blue-500/20"><i data-lucide="lightbulb" class="w-2.5 h-2.5"></i> Concept</span>`;
                    } else {
                        statusBadge = `<span class="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/20 text-emerald-400 rounded-lg text-[8px] font-black uppercase tracking-widest border border-emerald-500/20"><i data-lucide="check-circle-2" class="w-2.5 h-2.5"></i> PubliÃ©</span>`;
                    }
                }

                // Play Store Detection
                const isPlayStore = e.project_url && e.project_url.includes('play.google.com');
                const playBadge = isPlayStore ? `<span class="flex items-center gap-1.5 px-2.5 py-1 bg-white/10 text-white rounded-lg text-[8px] font-black uppercase tracking-widest border border-white/10"><i data-lucide="play" class="w-2.5 h-2.5 fill-current"></i> Google Play</span>` : "";

                return `
                    <div class="flex flex-col md:flex-row gap-8 md:gap-20 group">
                        <div class="md:w-56 pt-2 md:pt-8 flex flex-col items-center md:items-end text-center md:text-right">
                            <span class="text-sm md:text-lg font-black uppercase text-gradient mb-2">${escapeHtml(e.period)}</span>
                            <div class="w-12 md:w-20 h-0.5 md:h-1 bg-white/5 rounded-full group-hover:bg-cyan-500 transition-all"></div>
                        </div>
                        <div class="flex-1 pb-16 md:pb-32 border-l border-white/5 pl-8 md:pl-20 relative">
                            <div class="absolute -left-[9px] top-4 md:top-8 w-4 h-4 bg-[#0a0a0c] border-2 border-cyan-500 rounded-full group-hover:scale-150 transition-all"></div>
                            <div class="flex flex-col sm:flex-row gap-6 md:gap-12 items-start mb-8 md:mb-12">
                                ${e.logo_url ? `<div class="w-20 h-20 md:w-40 md:h-40 rounded-3xl overflow-hidden bg-white p-2 md:p-3 shadow-2xl shrink-0"><img src="${getFullUrl(e.logo_url)}" class="w-full h-full object-contain"></div>` : ''}
                                <div class="flex-1 min-w-0">
                                    <div class="flex items-center gap-3 mb-3 flex-wrap">
                                        ${statusBadge}
                                        ${playBadge}
                                        <div class="flex gap-3">
                                            <span class="flex items-center gap-1 text-[9px] font-black text-gray-500 uppercase"><i data-lucide="download" class="w-2.5 h-2.5"></i> ${escapeHtml(e.downloads_count || '0')}</span>
                                            <span class="flex items-center gap-1 text-[9px] font-black text-gray-500 uppercase"><i data-lucide="star" class="w-2.5 h-2.5 text-amber-400 fill-current"></i> ${escapeHtml(e.stars_count || '5.0')}</span>
                                        </div>
                                    </div>
                                    <h4 class="text-3xl md:text-6xl font-black uppercase text-white group-hover:text-cyan-400 transition-all leading-none truncate">${escapeHtml(e.title)}</h4>
                                    <p class="text-[10px] md:text-sm font-black text-purple-400 uppercase tracking-widest mt-2 md:mt-4">${escapeHtml(e.company)}</p>
                                </div>
                            </div>
                            <div class="glass p-6 md:p-12 rounded-[2rem] md:rounded-[4rem] border-white/10 bg-white/[0.01] shadow-2xl relative">
                                <p class="text-gray-400 font-medium leading-relaxed text-base md:text-xl italic mb-8">"${escapeHtml(e.description)}"</p>
                                ${e.project_url ? `
                                    <a href="${escapeHtml(e.project_url)}" target="_blank" class="inline-flex items-center gap-3 px-8 py-3 bg-white text-black rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-cyan-500 hover:text-white transition-all">
                                        DÃ©couvrir le projet <i data-lucide="external-link" class="w-3 h-3"></i>
                                    </a>
                                ` : (e.is_in_progress ? '<p class="text-[10px] font-black text-amber-400 uppercase tracking-[0.2em] italic">Projet en cours de dÃ©veloppement...</p>' : '')}
                            </div>
                        </div>
                    </div>`;
            }).join('');
            lucide.createIcons();
        }
        function renderServices(services) {
            document.getElementById('services-grid').innerHTML = services.map(s => `
                <div class="glass p-8 md:p-20 rounded-[3rem] md:rounded-[5rem] border-white/10 flex flex-col h-full hover:border-cyan-500/30 transition-all group relative overflow-hidden text-left">
                    <div class="w-16 h-16 md:w-28 md:h-28 bg-cyan-500/10 text-cyan-400 rounded-3xl md:rounded-[2.5rem] flex items-center justify-center mb-8 md:mb-16 group-hover:bg-cyan-500 group-hover:text-white transition-all shadow-2xl border border-white/5"><i data-lucide="layout" class="w-8 h-8 md:w-14 md:h-14"></i></div>
                    <h4 class="text-3xl md:text-5xl font-black uppercase text-white mb-4 md:mb-8 tracking-tighter">${escapeHtml(s.title)}</h4>
                    <p class="text-gray-400 font-medium text-base md:text-xl leading-relaxed mb-8 md:mb-16 flex-1">${escapeHtml(s.description)}</p>
                    <div class="pt-6 md:pt-10 border-t border-white/5 mt-auto flex items-center justify-between flex-wrap gap-4">
                        <p class="text-sm md:text-lg font-black text-cyan-400 uppercase tracking-widest">DÃ¨s ${escapeHtml(s.price_range || 'N/C')}</p>
                        <button onclick="requestService('${escapeHtml(s.title).replace(/'/g, "\\'")}')" class="px-6 md:px-10 py-3 md:py-5 bg-white text-black rounded-xl md:rounded-2xl font-black text-[10px] md:text-xs uppercase hover:bg-cyan-500 hover:text-white transition-all">Devis</button>
                    </div>
                </div>`).join('');
        }

        function requestService(title) {
            const budget = prompt("Quel est votre budget estimÃ© pour ce service (" + title + ") ?", "500$");
            if (!budget) return;
            document.getElementById('budget').value = budget;
            document.getElementById('projectDesc').value = "Demande pour le service : " + title;
            document.getElementById('specifications').placeholder = "DÃ©taillez vos besoins pour : " + title;
            scrollToContact();
        }
        function renderProfile(p) {
            if (!p) return;
            const logoImg = document.getElementById('site-logo');
            const footerLogo = document.getElementById('footer-logo');
            const discordLogo = document.getElementById('discord-main-logo');
            const discordFallback = document.getElementById('discord-main-fallback');

            if (p.logo_url) {
                const url = getFullUrl(p.logo_url);
                if (logoImg) {
                    logoImg.src = url;
                    logoImg.classList.remove('hidden');
                }
                const siteFallback = document.getElementById('site-logo-fallback');
                if (siteFallback) siteFallback.classList.add('hidden');

                if (footerLogo) {
                    footerLogo.src = url;
                    footerLogo.classList.remove('hidden');
                }
                const footerFallback = document.getElementById('footer-logo-fallback');
                if (footerFallback) footerFallback.classList.add('hidden');

                if (discordLogo) {
                    discordLogo.src = url;
                    discordLogo.classList.remove('hidden');
                }
                if (discordFallback) discordFallback.classList.add('hidden');
            }

            const aboutPhoto = document.getElementById('about-photo');
            if (aboutPhoto && p.about_photo_url) aboutPhoto.src = getFullUrl(p.about_photo_url);

            const heroImg = document.getElementById('hero-image');
            if (heroImg && p.hero_image_url) heroImg.src = getFullUrl(p.hero_image_url);

            // Save about_description into a global window variable to inject into secret blocks if needed
            window.togetherStoryText = p.about_description || "";
            const footerContact = document.getElementById('footer-contact-info');
            if (footerContact && p.footer_contact) footerContact.innerText = p.footer_contact;

            // Render Social Links
            const socialContainer = document.getElementById('footer-social-links');
            if (socialContainer) {
                const socials = [
                    { id: 'facebook', url: p.social_facebook, icon: 'facebook', customIcon: p.social_facebook_icon, color: 'hover:bg-blue-600' },
                    { id: 'github', url: p.social_github, icon: 'github', customIcon: p.social_github_icon, color: 'hover:bg-gray-800' },
                    { id: 'whatsapp', url: p.social_whatsapp, icon: 'message-circle', customIcon: p.social_whatsapp_icon, color: 'hover:bg-green-500' },
                    { id: 'instagram', url: p.social_instagram, icon: 'instagram', customIcon: p.social_instagram_icon, color: 'hover:bg-pink-600' },
                    { id: 'twitter', url: p.social_twitter, icon: 'twitter', customIcon: p.social_twitter_icon, color: 'hover:bg-blue-400' }
                ];
                socialContainer.innerHTML = socials.filter(s => s.url).map(s => `
                    <a href="${escapeHtml(s.url)}" target="_blank" class="w-10 h-10 md:w-12 md:h-12 glass rounded-2xl flex items-center justify-center text-gray-500 hover:text-white ${s.color} transition-all overflow-hidden p-2">
                        ${s.customIcon ? `<img src="${getFullUrl(s.customIcon)}" class="w-full h-full object-contain">` : `<i data-lucide="${s.icon}" class="w-5 h-5"></i>`}
                    </a>
                `).join('');
                lucide.createIcons();
            }

            // Apply Animated Background
            if (p.background_url) {
                const bgContainer = document.getElementById('portfolio-bg-container');
                const bgImg = document.getElementById('portfolio-bg-image');
                if (bgImg) {
                    bgImg.src = getFullUrl(p.background_url);
                    if (bgContainer) bgContainer.classList.remove('hidden');

                    // Reset animations
                    bgImg.className = "";
                    if (p.background_animation && p.background_animation !== 'none') {
                        bgImg.classList.add('anim-' + p.background_animation);
                    }
                }
            }
        }
        function escapeHtml(value) { return String(value ?? '').replace(/[&<>\'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
        async function submitQuoteForm(event) {
            event.preventDefault();
            const button = document.getElementById('submit-btn-home');
            const data = {
                clientName: document.getElementById('clientName').value.trim(),
                clientEmail: document.getElementById('clientEmail').value.trim(),
                projectDescription: document.getElementById('specifications').value.trim(),
                budget: document.getElementById('budget').value,
                specifications: document.getElementById('specifications').value.trim(),
                portfolioId
            };
            if (!data.clientName || !data.clientEmail) return toast('Nom et email requis', 'error');
            try {
                button.disabled = true;
                button.innerText = 'ENVOI...';
                const res = await axios.post(`${API_BASE}/quote`, data);
                if (!res.data?.success) throw new Error(res.data?.error || 'Envoi impossible');
                event.target.reset();
                toast('Demande envoyÃ©e avec succÃ¨s', 'success');
            } catch (error) {
                toast(error.response?.data?.error || 'Impossible dâ€™envoyer la demande', 'error');
            } finally {
                button.disabled = false;
                button.innerText = 'Envoyer la demande';
            }
        }
        function getFullUrl(url) { if (!url || url === 'null') return 'https://placehold.co/400x400/000/fff?text=Photo'; if (url.startsWith('http')) return url; return '/' + url.replace(/^\//, ''); }
        function scrollToContact() { navigateTo('home'); setTimeout(() => document.getElementById('contact-home').scrollIntoView({ behavior: 'smooth' }), 100); }
        async function authTracking() {
            const email = document.getElementById('track-email').value.trim();
            const code = document.getElementById('track-code')?.value.trim();

            if (!email) return toast('Saisissez votre email', 'error');

            if (!code) {
                // Ã‰tape 1 : Demander le code
                try {
                    const button = document.querySelector('#tracking-auth button');
                    button.disabled = true;
                    button.innerText = 'ENVOI DU CODE...';
                    await axios.post(`${API_BASE}/client/tracking/request`, { email });

                    // Afficher le champ code
                    document.getElementById('tracking-auth').innerHTML = `
                        <div class="w-16 h-16 md:w-20 md:h-20 bg-purple-500/10 rounded-3xl flex items-center justify-center text-purple-400 mb-6"><i data-lucide="mail" class="w-10 h-10"></i></div>
                        <p class="text-gray-400 text-sm mb-6">Un code de vÃ©rification a Ã©tÃ© envoyÃ© Ã  <b>${escapeHtml(email)}</b></p>
                        <input type="hidden" id="track-email" value="${escapeHtml(email)}">
                        <input type="text" id="track-code" placeholder="Code Ã  6 chiffres" class="w-full max-w-sm bg-white/5 border border-white/10 p-5 rounded-2xl outline-none focus:border-cyan-500 transition-all font-black text-center text-white text-2xl tracking-[0.5em] mb-4">
                        <button onclick="authTracking()" class="w-full max-w-sm py-5 bg-cyan-500 text-white rounded-2xl font-black text-xs uppercase shadow-xl hover:bg-cyan-600">VÃ©rifier le code</button>
                        <button onclick="location.reload()" class="mt-4 text-[10px] text-gray-500 uppercase font-bold hover:text-white transition-all">Utiliser un autre email</button>
                    `;
                    lucide.createIcons();
                } catch (error) {
                    toast(error.response?.data?.error || 'Erreur lors de la demande', 'error');
                } finally {
                    const button = document.querySelector('#tracking-auth button');
                    if (button) {
                        button.disabled = false;
                        button.innerText = 'VÃ©rifier le code';
                    }
                }
                return;
            }

            // Ã‰tape 2 : VÃ©rifier le code et charger les devis
            try {
                const res = await axios.get(`${API_BASE}/client/tracking`, { params: { email, code } });
                const quotes = res.data?.data || [];
                document.getElementById('tracking-auth').classList.add('hidden');
                document.getElementById('tracking-content').classList.remove('hidden');
                const list = document.getElementById('quotes-list-client');
                list.innerHTML = quotes.map(quote => `
                    <button class="w-full text-left p-4 mb-3 rounded-2xl bg-white/5 hover:bg-cyan-500/10 border border-white/5 transition-all group" data-quote-id="${escapeHtml(quote.id)}">
                        <p class="text-white font-bold text-sm truncate group-hover:text-cyan-400">${escapeHtml(quote.project_description || 'Demande de devis')}</p>
                        <p class="text-gray-500 text-[10px] uppercase font-black mt-1">${escapeHtml(quote.status || 'En attente')}</p>
                    </button>
                `).join('');

                list.querySelectorAll('[data-quote-id]').forEach(button => {
                    button.addEventListener('click', () => loadQuoteDetail(quotes.find(q => q.id === button.dataset.quoteId)));
                });

                if (quotes.length) loadQuoteDetail(quotes[0]);
                else document.getElementById('quote-detail-view').innerHTML = '<div class="h-full flex items-center justify-center text-gray-500">Aucune demande trouvÃ©e.</div>';
            } catch (error) {
                toast(error.response?.data?.error || 'Code invalide ou expirÃ©', 'error');
            }
        }
        async function loadQuoteDetail(quote) {
            if (!quote) return;
            currentQuoteId = quote.id;
            document.getElementById('quote-detail-view').innerHTML = `
                <div class="h-full flex flex-col">
                    <div class="p-6 md:p-10 border-b border-white/5 bg-dot">
                        <h4 class="text-2xl font-black text-white uppercase italic tracking-tighter">${escapeHtml(quote.project_description || 'Demande de devis')}</h4>
                        <div class="flex items-center gap-4 mt-2">
                            <p class="text-cyan-400 text-[10px] font-black uppercase tracking-widest">ID: ${escapeHtml(quote.id.split('-')[0])}</p>
                            <span class="px-3 py-1 bg-white/5 border border-white/10 rounded-lg text-[9px] font-black uppercase text-gray-400">${escapeHtml(quote.status || 'En attente')}</span>
                        </div>
                    </div>

                    <div class="flex-1 overflow-y-auto p-6 md:p-10 space-y-10 custom-scrollbar">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div class="glass p-6 rounded-[2rem] border-white/5">
                                <p class="text-gray-500 text-[9px] font-black uppercase tracking-widest mb-2">Budget EstimÃ©</p>
                                <p class="text-white font-bold text-lg">${escapeHtml(quote.budget || 'Non spÃ©cifiÃ©')}</p>
                            </div>
                            <div class="glass p-6 rounded-[2rem] border-white/5">
                                <p class="text-gray-500 text-[9px] font-black uppercase tracking-widest mb-2">Date de demande</p>
                                <p class="text-white font-bold text-lg">${new Date(quote.created_at).toLocaleDateString()}</p>
                            </div>
                        </div>

                        <div class="glass p-8 rounded-[2.5rem] border-white/5 relative group">
                            <h5 class="text-white font-black text-xs uppercase tracking-widest mb-6 flex items-center justify-between">
                                <span class="flex items-center gap-3"><i data-lucide="file-text" class="w-4 h-4 text-cyan-400"></i> Cahier des charges</span>
                                <button onclick="toggleSpecsEdit()" class="text-[9px] text-gray-500 hover:text-cyan-400 transition-all opacity-0 group-hover:opacity-100 uppercase font-black">Modifier</button>
                            </h5>
                            <div id="specs-display" class="text-gray-300 text-sm leading-relaxed whitespace-pre-line">${escapeHtml(quote.specifications || 'Aucune spÃ©cification dÃ©taillÃ©e.')}</div>
                            <div id="specs-edit-box" class="hidden space-y-4">
                                <textarea id="specs-input" class="w-full bg-white/5 border border-white/10 rounded-2xl p-6 text-gray-200 text-sm min-h-[200px] outline-none focus:border-cyan-500">${escapeHtml(quote.specifications || '')}</textarea>
                                <div class="flex justify-end gap-3">
                                    <button onclick="toggleSpecsEdit()" class="px-6 py-3 text-[10px] font-black uppercase text-gray-500">Annuler</button>
                                    <button onclick="saveSpecs()" class="px-6 py-3 bg-cyan-500 text-white rounded-xl text-[10px] font-black uppercase shadow-lg shadow-cyan-500/20">Enregistrer</button>
                                </div>
                            </div>
                        </div>

                        <!-- Contract Section -->
                        ${quote.contract_content ? `
                        <div class="glass p-8 rounded-[2.5rem] border-purple-500/20 bg-purple-500/5 relative overflow-hidden">
                            <div class="absolute -top-20 -right-20 w-40 h-40 bg-purple-500/10 blur-[60px] rounded-full"></div>
                            <h5 class="text-white font-black text-xs uppercase tracking-widest mb-6 flex items-center gap-3">
                                <i data-lucide="scroll" class="w-4 h-4 text-purple-400"></i> Contrat Digital
                            </h5>
                            <div class="bg-black/20 p-6 rounded-2xl text-xs text-gray-400 leading-relaxed font-mono mb-8 max-h-60 overflow-y-auto custom-scrollbar border border-white/5 italic">
                                ${quote.contract_content}
                            </div>

                            ${quote.contract_signed_at ? `
                                <div class="flex items-center gap-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                                    <i data-lucide="check-circle" class="w-6 h-6 text-emerald-500"></i>
                                    <div>
                                        <p class="text-emerald-500 font-black text-[10px] uppercase">SignÃ© numÃ©riquement</p>
                                        <p class="text-gray-500 text-[8px] uppercase font-bold">Le ${new Date(quote.contract_signed_at).toLocaleString()}</p>
                                    </div>
                                </div>
                            ` : `
                                <div class="flex flex-col sm:flex-row items-center justify-between gap-6">
                                    <p class="text-[10px] text-gray-500 uppercase font-bold max-w-xs">En cliquant sur signer, vous acceptez les termes du contrat pour le lancement du projet.</p>
                                    <button onclick="signContract()" class="w-full sm:w-auto px-10 py-4 bg-purple-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:scale-105 transition-all">Signer le contrat</button>
                                </div>
                            `}
                        </div>
                        ` : ''}

                        <!-- Chat Section -->
                        <div class="space-y-6">
                            <h5 class="text-white font-black text-xs uppercase tracking-widest flex items-center gap-3">
                                <i data-lucide="messages-square" class="w-4 h-4 text-purple-400"></i> Discussion Directe
                            </h5>
                            <div id="quote-chat" class="space-y-4">
                                <div class="text-center py-10 opacity-20 text-[10px] font-black uppercase">Chargement de la conversation...</div>
                            </div>
                        </div>
                    </div>

                    <!-- Input Chat -->
                    <div class="p-6 md:p-8 border-t border-white/5 bg-[#0a0a0c]">
                        <div class="flex gap-3">
                            <input id="quote-chat-input" class="flex-1 bg-white/5 border border-white/10 rounded-2xl p-5 text-white outline-none focus:border-cyan-500 transition-all font-medium" placeholder="Posez une question sur votre projet...">
                            <button id="quote-chat-send" class="px-8 bg-cyan-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:scale-105 transition-all">Envoyer</button>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('quote-chat-send').addEventListener('click', sendQuoteMessage);
            document.getElementById('quote-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendQuoteMessage(); });
            lucide.createIcons();
            await loadQuoteChat();
        }

        async function loadQuoteChat() {
            if (!currentQuoteId) return;
            try {
                const email = document.getElementById('track-email').value;
                const code = document.getElementById('track-code').value;
                const res = await axios.get(`${API_BASE}/chat/${currentQuoteId}`, { params: { email, code } });
                const messages = res.data?.data || [];
                const container = document.getElementById('quote-chat');

                if (messages.length === 0) {
                    container.innerHTML = '<div class="text-center py-10 opacity-30 text-[10px] font-black uppercase">Aucun message pour le moment.</div>';
                    return;
                }

                container.innerHTML = messages.map(msg => `
                    <div class="flex ${msg.sender_type === 'client' ? 'justify-end' : 'justify-start'}">
                        <div class="max-w-[80%] p-4 rounded-2xl ${msg.sender_type === 'client' ? 'bg-cyan-500 text-white' : 'bg-white/5 text-gray-200 border border-white/10'}">
                            <p class="text-[8px] font-black uppercase mb-1 opacity-60">${msg.sender_type === 'client' ? 'Vous' : 'Expert Together'}</p>
                            <p class="text-sm font-medium leading-relaxed">${escapeHtml(msg.content)}</p>
                            <p class="text-[7px] font-bold uppercase mt-2 opacity-40 text-right">${timeAgo(msg.created_at)}</p>
                        </div>
                    </div>
                `).join('');
                container.scrollTop = container.scrollHeight;
            } catch (error) {
                console.error('Chat loading error:', error);
            }
        }

        async function sendQuoteMessage() {
            const input = document.getElementById('quote-chat-input');
            const content = input.value.trim();
            if (!content || !currentQuoteId) return;

            try {
                const email = document.getElementById('track-email').value;
                const code = document.getElementById('track-code').value;
                const res = await axios.post(`${API_BASE}/chat/${currentQuoteId}`, {
                    content,
                    senderType: 'client',
                    email,
                    code
                });
                if (res.data?.success) {
                    input.value = '';
                    await loadQuoteChat();
                }
            } catch (error) {
                toast('Erreur lors de lâ€™envoi du message', 'error');
            }
        }

        function toggleSpecsEdit() {
            document.getElementById('specs-display').classList.toggle('hidden');
            document.getElementById('specs-edit-box').classList.toggle('hidden');
        }

        async function saveSpecs() {
            const specs = document.getElementById('specs-input').value.trim();
            try {
                const email = document.getElementById('track-email').value;
                const code = document.getElementById('track-code').value;
                const res = await axios.put(`${API_BASE}/client/quotes/${currentQuoteId}/specs`, { specs, email, code });
                if (res.data?.success) {
                    toast('Cahier des charges mis Ã  jour', 'success');
                    toggleSpecsEdit();
                    // Recharger les donnÃ©es du devis
                    const quotesRes = await axios.get(`${API_BASE}/client/tracking`, { params: { email, code } });
                    const updatedQuote = quotesRes.data.data.find(q => q.id === currentQuoteId);
                    loadQuoteDetail(updatedQuote);
                }
            } catch (e) { toast('Erreur mise Ã  jour', 'error'); }
        }

        async function signContract() {
            if (!confirm('Souhaitez-vous signer numÃ©riquement ce contrat pour lancer le projet ?')) return;
            try {
                const email = document.getElementById('track-email').value;
                const code = document.getElementById('track-code').value;
                const res = await axios.post(`${API_BASE}/client/quotes/${currentQuoteId}/sign`, { email, code });
                if (res.data?.success) {
                    toast('Contrat signÃ© avec succÃ¨s !', 'success');
                    const quotesRes = await axios.get(`${API_BASE}/client/tracking`, { params: { email, code } });
                    const updatedQuote = quotesRes.data.data.find(q => q.id === currentQuoteId);
                    loadQuoteDetail(updatedQuote);
                }
            } catch (e) { toast('Erreur signature', 'error'); }
        }
        function openTrackingModal() { document.getElementById('modal-tracking').classList.remove('hidden'); }
        function closeTrackingModal() { document.getElementById('modal-tracking').classList.add('hidden'); }
        function previewPortfolioImg(input, previewId) { if (input.files && input.files[0]) { const reader = new FileReader(); reader.onload = (e) => document.getElementById(previewId).src = e.target.result; reader.readAsDataURL(input.files[0]); } }
        function showPortfolioRequestModal() { document.getElementById('modal-request-portfolio').classList.remove('hidden'); lucide.createIcons(); }
        async function submitSaasRequest(e) { e.preventDefault(); const btn = e.target.querySelector('button'); const logoFile = document.getElementById('saas-logo-input').files[0]; const selectedModules = Array.from(document.querySelectorAll('input[name="saas-modules"]:checked')).map(cb => cb.value); if (!selectedModules.includes('home')) selectedModules.push('home'); if (!selectedModules.includes('about')) selectedModules.push('about'); if (!selectedModules.includes('contact')) selectedModules.push('contact'); try { btn.innerText = "ENVOI..."; btn.disabled = true; let logoUrl = null; if (logoFile) { const formData = new FormData(); formData.append('file', logoFile); const upRes = await axios.post(`${API_BASE}/upload-logo`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }); logoUrl = upRes.data.data.fileUrl; } const data = { fullName: document.getElementById('saas-name').value, email: document.getElementById('saas-email').value, profession: document.getElementById('saas-profession').value, desiredSlug: document.getElementById('saas-slug').value, preferredColor: document.getElementById('saas-color').value, motivation: document.getElementById('saas-motivation').value, enabledModules: selectedModules, logoUrl }; await axios.post(`${API_BASE}/request`, data); alert("Demande envoyÃ©e !"); document.getElementById('modal-request-portfolio').classList.add('hidden'); e.target.reset(); document.getElementById('saas-logo-preview').src = 'https://ui-avatars.com/api/?name=Logo'; } catch (err) { alert(err.response?.data?.error || "Erreur."); } finally { btn.innerText = "SOUMETTRE MA DEMANDE"; btn.disabled = false; } }
        function showToast(title, message, icon = 'bell') { console.log(title, message); }
    
