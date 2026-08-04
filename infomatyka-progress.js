/* InfoMatyka CDN | infomatyka-progress.js | wydzielono z InfoMatyka_Website_Theme.html */
(function() {
      const STORAGE_KEY = 'infomatyka_postep_uzytkownika';

      let globalConfig = {
        xpBrackets: [
          { maxLevel: 9999, xpRequired: 500 }
        ],
        xpRewards: {
          gra: 100,
          quiz: 50,
          wizualizacja: 20,
          zadanieDnia: 30
        },
        achievements: [
          { id: 'xp_100', name: 'Młody Adept', desc: 'Zdobądź łącznie 100 XP', icon: 'fa-solid fa-seedling', target: 'totalXp', val: 100 },
          { id: 'xp_1000', name: 'Uczeń Czarnoksiężnika', desc: 'Zdobądź łącznie 1000 XP', icon: 'fa-solid fa-wand-magic-sparkles', target: 'totalXp', val: 1000 },
          { id: 'first_game', name: 'Pierwsze Koty', desc: 'Ukończ pierwszą grę', icon: 'fa-solid fa-gamepad', target: 'gamesPlayed', val: 1 },
          { id: 'daily_first', name: 'Pierwszy krok', desc: 'Ukończ pierwsze zadanie dnia', icon: 'fa-solid fa-calendar-check', target: 'dailyTasksCompleted', val: 1 },
          { id: 'daily_7', name: 'Tydzień bez przerwy', desc: 'Rozwiązuj zadanie dnia przez 7 dni z rzędu', icon: 'fa-solid fa-fire', target: 'maxDailyTaskStreak', val: 7 },
          { id: 'daily_30', name: 'Miesiąc wytrwałości', desc: 'Rozwiązuj zadanie dnia przez 30 dni z rzędu', icon: 'fa-solid fa-medal', target: 'maxDailyTaskStreak', val: 30 },
          { id: 'daily_365', name: 'Rok konsekwencji', desc: 'Rozwiązuj zadanie dnia przez 365 dni z rzędu', icon: 'fa-solid fa-trophy', target: 'maxDailyTaskStreak', val: 365 }
        ]
      };

      window.InfoMatykaSDK = {
        config: null,

        renderPostBanner: function(bannerConfig) {
          var container = document.getElementById('custom-post-banner');
          if (!container) return;

          if (!bannerConfig || !bannerConfig.active) {
            container.classList.add('hidden');
            return;
          }

          var types = {
            info: {
              bg: 'bg-blue-50 border-blue-200 text-blue-800',
              iconColor: 'text-blue-500',
              btnClass: 'bg-blue-600 hover:bg-blue-700 text-white visited:text-white',
              defaultIcon: 'fa-info-circle'
            },
            warning: {
              bg: 'bg-amber-50 border-amber-200 text-amber-800',
              iconColor: 'text-amber-500',
              btnClass: 'bg-amber-600 hover:bg-amber-700 text-white visited:text-white',
              defaultIcon: 'fa-exclamation-triangle'
            },
            success: {
              bg: 'bg-emerald-50 border-emerald-200 text-emerald-800',
              iconColor: 'text-emerald-500',
              btnClass: 'bg-emerald-600 hover:bg-emerald-700 text-white visited:text-white',
              defaultIcon: 'fa-check-circle'
            },
            danger: {
              bg: 'bg-red-50 border-red-200 text-red-800',
              iconColor: 'text-red-500',
              btnClass: 'bg-red-600 hover:bg-red-700 text-white visited:text-white',
              defaultIcon: 'fa-exclamation-circle'
            },
            custom: {
              bg: '',
              iconColor: '',
              btnClass: '',
              defaultIcon: 'fa-bullhorn'
            }
          };

          var type = bannerConfig.type || 'info';
          var styleConfig = types[type] || types.info;

          container.className = 'w-full mb-6 p-4 rounded-xl shadow-sm border text-left flex items-start space-x-3 transition-all duration-300';
          
          if (type === 'custom') {
            container.style.backgroundColor = bannerConfig.backgroundColor || '#f9fafb';
            container.style.borderColor = bannerConfig.borderColor || '#e5e7eb';
            container.style.color = bannerConfig.textColor || '#1f2937';
          } else {
            var classes = styleConfig.bg.split(' ');
            for (var i = 0; i < classes.length; i++) {
              container.classList.add(classes[i]);
            }
            container.style.backgroundColor = '';
            container.style.borderColor = '';
            container.style.color = '';
          }

          var iconName = bannerConfig.icon || styleConfig.defaultIcon;
          var iconColor = type === 'custom' ? (bannerConfig.iconColor || bannerConfig.textColor || '') : styleConfig.iconColor;
          
          var iconClass = '';
          if (iconName.indexOf('fa-') !== -1) {
            iconClass = iconName;
            if (iconName.indexOf('fa ') === -1) {
              iconClass = 'fa ' + iconClass;
            }
          } else {
            iconClass = 'fa fa-' + iconName;
          }

          var actionBtnHtml = '';
          if (bannerConfig.link && bannerConfig.linkText) {
            if (type === 'custom') {
              var btnBg = bannerConfig.buttonBackgroundColor || '#111827';
              var btnText = bannerConfig.buttonTextColor || '#ffffff';
              actionBtnHtml = '<a href="' + bannerConfig.link + '" class="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 hover:opacity-90" style="background-color: ' + btnBg + '; color: ' + btnText + '; text-decoration: none !important;">' + bannerConfig.linkText + '</a>';
            } else {
              actionBtnHtml = '<a href="' + bannerConfig.link + '" class="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ' + styleConfig.btnClass + '" style="text-decoration: none !important;">' + bannerConfig.linkText + '</a>';
            }
          }

          var iconStyle = type === 'custom' && iconColor ? ' style="color: ' + iconColor + ';"' : '';
          var iconMarkup = '<div class="flex-shrink-0 mt-0.5"><i class="' + iconClass + ' text-xl ' + iconColor + '"' + iconStyle + '></i></div>';

          container.innerHTML = iconMarkup +
            '<div class="flex-grow flex flex-col md:flex-row md:items-center md:justify-between gap-4">' +
              '<div class="text-sm font-medium leading-relaxed">' +
                (bannerConfig.text || '') +
              '</div>' +
              (actionBtnHtml ? '<div class="flex-shrink-0">' + actionBtnHtml + '</div>' : '') +
            '</div>';

          container.classList.remove('hidden');
        },

        renderPageBanner: function(bannerConfig) {
          var container = document.getElementById('custom-page-banner');
          if (!container) return;

          if (!bannerConfig || !bannerConfig.active || sessionStorage.getItem('infomatyka_page_banner_dismissed') === 'true') {
            container.classList.add('hidden');
            return;
          }

          var types = {
            info: {
              bg: 'bg-cyan-600 text-white',
              btnClass: 'bg-white text-cyan-700 hover:bg-cyan-50 focus:ring-cyan-300',
              defaultIcon: 'fa-info-circle'
            },
            warning: {
              bg: 'bg-amber-500 text-white',
              btnClass: 'bg-white text-amber-700 hover:bg-amber-50 focus:ring-amber-300',
              defaultIcon: 'fa-exclamation-triangle'
            },
            success: {
              bg: 'bg-emerald-600 text-white',
              btnClass: 'bg-white text-emerald-700 hover:bg-emerald-50 focus:ring-emerald-300',
              defaultIcon: 'fa-check-circle'
            },
            danger: {
              bg: 'bg-gradient-to-r from-rose-600 via-red-600 to-rose-600 text-white',
              btnClass: 'bg-white text-red-700 hover:bg-red-50 focus:ring-red-300 shadow-sm',
              defaultIcon: 'fa-solid fa-shield-virus animate-pulse'
            },
            custom: {
              bg: '',
              btnClass: '',
              defaultIcon: 'fa-bullhorn'
            }
          };

          var type = bannerConfig.type || 'info';
          var styleConfig = types[type] || types.info;

          container.className = 'w-full flex-shrink-0 z-50 shadow-md transition-all duration-300 relative';
          
          if (type === 'custom') {
            container.style.backgroundColor = bannerConfig.backgroundColor || '#1f2937';
            container.style.color = bannerConfig.textColor || '#ffffff';
          } else {
            var classes = styleConfig.bg.split(' ');
            for (var i = 0; i < classes.length; i++) {
              container.classList.add(classes[i]);
            }
            container.style.backgroundColor = '';
            container.style.color = '';
          }

          var iconName = bannerConfig.icon || styleConfig.defaultIcon;
          var iconClass = '';
          if (iconName.indexOf('fa-') !== -1) {
            iconClass = iconName;
            if (iconName.indexOf('fa ') === -1) {
              iconClass = 'fa ' + iconClass;
            }
          } else {
            iconClass = 'fa fa-' + iconName;
          }

          var actionBtnHtml = '';
          if (bannerConfig.link && bannerConfig.linkText) {
            if (type === 'custom') {
              var btnBg = bannerConfig.buttonBackgroundColor || '#ffffff';
              var btnText = bannerConfig.buttonTextColor || '#1f2937';
              actionBtnHtml = '<a href="' + bannerConfig.link + '" class="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2" style="background-color: ' + btnBg + '; color: ' + btnText + '; text-decoration: none !important;">' + bannerConfig.linkText + '</a>';
            } else {
              actionBtnHtml = '<a href="' + bannerConfig.link + '" class="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ' + styleConfig.btnClass + ' focus:outline-none focus:ring-2 focus:ring-offset-2" style="text-decoration: none !important;">' + bannerConfig.linkText + '</a>';
            }
          }

          var closeBtnHtml = '';
          if (bannerConfig.dismissible !== false) {
            closeBtnHtml = '<button id="close-page-banner-btn" class="flex-shrink-0 text-white/80 hover:text-white transition-colors p-1 -mr-1 rounded-md hover:bg-white/10 focus:outline-none" aria-label="Zamknij powiadomienie">' +
              '<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>' +
            '</button>';
          }

          var textMarkup = bannerConfig.text || '';
          
          container.innerHTML = 
            '<div class="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 flex-wrap sm:flex-nowrap">' +
              '<div class="flex items-center gap-3 min-w-0 flex-grow md:flex-grow-0">' +
                '<span class="flex p-1 rounded-lg bg-black/10 text-xl flex-shrink-0">' +
                  '<i class="' + iconClass + '"></i>' +
                '</span>' +
                '<p class="text-sm font-medium text-white leading-tight text-left">' +
                  textMarkup +
                '</p>' +
              '</div>' +
              '<div class="flex items-center gap-3 flex-shrink-0 ml-auto md:ml-0">' +
                (actionBtnHtml ? '<div class="order-1 sm:order-none">' + actionBtnHtml + '</div>' : '') +
                closeBtnHtml +
              '</div>' +
            '</div>';

          container.classList.remove('hidden');

          if (bannerConfig.dismissible !== false) {
            var closeBtn = document.getElementById('close-page-banner-btn');
            if (closeBtn) {
              closeBtn.addEventListener('click', function() {
                container.classList.add('hidden');
                sessionStorage.setItem('infomatyka_page_banner_dismissed', 'true');
              });
            }
          }
        },

        getLevelInfo: function(totalXp) {
          let brackets = globalConfig.xpBrackets;
          if (this.config && this.config.progressConfig && this.config.progressConfig.xpBrackets) {
            brackets = this.config.progressConfig.xpBrackets;
          } else if (this.config && this.config.progressConfig && this.config.progressConfig.xpPerLevel) {
            brackets = [{ maxLevel: 9999, xpRequired: this.config.progressConfig.xpPerLevel }];
          }

          let currentLvl = 1;
          let tempXp = totalXp;

          while (true) {
            const bracket = brackets.find(b => currentLvl <= b.maxLevel) || brackets[brackets.length - 1];
            const req = bracket.xpRequired;

            if (tempXp >= req) {
              tempXp -= req;
              currentLvl++;
            } else {
              return {
                level: currentLvl,
                xpInCurrentLevel: tempXp,
                xpNeededForNext: req,
                percent: (tempXp / req) * 100
              };
            }
          }
        },

        getProgress: function() {
          let raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) {
            return {
              xp: 0, streak: 0, lastActivityDate: null, completedToday: [], history: [], achievements: {},
              dailyTaskStreak: 0, lastDailyTaskDate: null, completedDailyTasks: {},
              settings: { trackingEnabled: true },
              stats: { totalXp: 0, gamesPlayed: 0, quizzesSolved: 0, visualizersViewed: 0, maxStreak: 0, dailyTasksCompleted: 0, maxDailyTaskStreak: 0 }
            };
          }
          let parsed = JSON.parse(raw);
          if (!parsed.settings) parsed.settings = { trackingEnabled: true };
          if (!parsed.stats) {
            parsed.stats = { totalXp: parsed.xp || 0, gamesPlayed: 0, quizzesSolved: 0, visualizersViewed: 0, maxStreak: parsed.streak || 0 };
          }
          if (!parsed.achievements) parsed.achievements = {};
          if (!parsed.completedToday) parsed.completedToday = [];
          if (!parsed.history) parsed.history = [];
          if (!parsed.completedDailyTasks) parsed.completedDailyTasks = {};
          if (!parsed.dailyTaskStreak) parsed.dailyTaskStreak = 0;
          if (!parsed.stats.dailyTasksCompleted) parsed.stats.dailyTasksCompleted = 0;
          if (!parsed.stats.maxDailyTaskStreak) parsed.stats.maxDailyTaskStreak = 0;

          if (parsed.streak > 0 && parsed.lastActivityDate) {
            const todayStr = new Date().toDateString();
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toDateString();
            if (parsed.lastActivityDate !== todayStr && parsed.lastActivityDate !== yesterdayStr) {
              parsed.streak = 0;
              localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
            }
          }

          return parsed;
        },

        saveProgress: function(data) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
          window.dispatchEvent(new Event('infomatyka_progress_updated'));
          this.updateNavbarDropdown();
        },

        getLocalDateKey: function(date) {
          var d = date || new Date();
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        },

        isDailyTaskCompleted: function(dateKey) {
          var key = dateKey || this.getLocalDateKey();
          return !!this.getProgress().completedDailyTasks[key];
        },

        completeDailyTask: function(taskId) {
          var data = this.getProgress();
          var todayKey = this.getLocalDateKey();
          if (data.completedDailyTasks[todayKey]) return { awarded: false, progress: data };
          if (data.settings && data.settings.trackingEnabled === false) return { awarded: false, trackingDisabled: true, progress: data };
          var yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          var yesterdayKey = this.getLocalDateKey(yesterday);
          data.dailyTaskStreak = data.lastDailyTaskDate === yesterdayKey ? data.dailyTaskStreak + 1 : 1;
          data.lastDailyTaskDate = todayKey;
          data.completedDailyTasks[todayKey] = taskId || todayKey;
          data.stats.dailyTasksCompleted = (data.stats.dailyTasksCompleted || 0) + 1;
          data.stats.maxDailyTaskStreak = Math.max(data.stats.maxDailyTaskStreak || 0, data.dailyTaskStreak);
          var baseXP = (this.config && this.config.progressConfig && this.config.progressConfig.xpRewards && this.config.progressConfig.xpRewards.zadanieDnia) || globalConfig.xpRewards.zadanieDnia;
          data.xp += baseXP;
          data.stats.totalXp += baseXP;
          data.history.unshift({ name: 'Zadanie dnia', type: 'zadanieDnia', score: 1, maxScore: 1, materialId: taskId || todayKey, xp: baseXP, timestamp: Date.now() });
          if (data.history.length > 30) data.history.pop();
          this.saveProgress(data);
          this.showToast('+' + baseXP + ' PD', 'Zadanie dnia ukończone', 'fa-solid fa-calendar-check');
          this.checkAchievements(data);
          return { awarded: true, xp: baseXP, progress: data };
        },

        registerActivity: function(activity) {
          let data = this.getProgress();

          if (data.settings && data.settings.trackingEnabled === false) {
            return;
          }

          const type = activity.type;
          const baseXP = (this.config && this.config.progressConfig && this.config.progressConfig.xpRewards && this.config.progressConfig.xpRewards[type])
                          ? this.config.progressConfig.xpRewards[type]
                          : (globalConfig.xpRewards[type] || 20);

          let earnedXP = baseXP;
          if (activity.score !== undefined && activity.maxScore !== undefined && activity.maxScore > 0) {
            let ratio = activity.score / activity.maxScore;
            earnedXP = Math.round(baseXP * ratio);
          }

          data.xp += earnedXP;
          data.stats.totalXp += earnedXP;

          if (type === 'gra') data.stats.gamesPlayed++;
          if (type === 'quiz') data.stats.quizzesSolved++;
          if (type === 'wizualizacja') data.stats.visualizersViewed++;

          const todayStr = new Date().toDateString();
          if (data.lastActivityDate !== todayStr) {
            if (data.lastActivityDate) {
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              if (data.lastActivityDate === yesterday.toDateString()) {
                data.streak++;
              } else {
                data.streak = 1;
              }
            } else {
              data.streak = 1;
            }
            data.lastActivityDate = todayStr;
            if (data.streak > data.stats.maxStreak) {
              data.stats.maxStreak = data.streak;
            }
          }

          data.history.unshift({
            name: activity.name,
            type: type,
            score: activity.score !== undefined ? activity.score : null,
            maxScore: activity.maxScore !== undefined ? activity.maxScore : null,
            materialId: activity.materialId || null,
            learningPath: activity.learningPath || null,
            learningStatus: activity.learningStatus || null,
            xp: earnedXP,
            timestamp: Date.now()
          });

          if (data.history.length > 30) data.history.pop();

          this.saveProgress(data);
          this.showToast(`+${earnedXP} XP`, activity.name, 'fa-solid fa-gem');

          this.checkAchievements(data);
        },

        checkAchievements: function(data) {
          let newlyUnlocked = [];
          const achievementsList = (this.config && this.config.progressConfig && this.config.progressConfig.achievements)
                                  ? this.config.progressConfig.achievements
                                  : globalConfig.achievements;

          achievementsList.forEach(ach => {
            if (!data.achievements[ach.id]) {
              const currentVal = data.stats[ach.target] || 0;
              if (currentVal >= ach.val) {
                data.achievements[ach.id] = true;
                newlyUnlocked.push(ach);
              }
            }
          });

          if (newlyUnlocked.length > 0) {
            this.saveProgress(data);
            newlyUnlocked.forEach(ach => {
              this.showToast(`Nowe osiągnięcie!`, ach.name, ach.icon, true);
            });
          }
        },

        showToast: function(title, text, icon, isAchievement = false) {
          const container = document.getElementById('infomatyka-toast-container');
          if (!container) return;

          const toast = document.createElement('div');
          toast.className = `im-toast ${isAchievement ? 'achievement-toast' : ''}`;

          toast.innerHTML = `
            <div style="background: ${isAchievement ? '#fef3c7' : '#ecfeff'}; color: ${isAchievement ? '#d97706' : '#0891b2'}; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <i class="${icon}"></i>
            </div>
            <div style="flex-grow: 1;">
              <div style="font-weight: 700; font-size: 14px; color: #1f2937;">${title}</div>
              <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">${text}</div>
            </div>
          `;

          container.appendChild(toast);
          setTimeout(() => toast.classList.add('show'), 100);
          setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
          }, 4000);
        },

        updateNavbarDropdown: function() {
          const data = this.getProgress();
          const totalXp = data.stats ? data.stats.totalXp : (data.xp || 0);
          const lvlInfo = this.getLevelInfo(totalXp);

          const xpEl = document.getElementById('nav-dropdown-xp');
          const lvlEl = document.getElementById('nav-dropdown-level');
          const streakEl = document.getElementById('nav-dropdown-streak');
          const barEl = document.getElementById('nav-dropdown-bar');

          if (lvlEl) lvlEl.textContent = `Poziom ${lvlInfo.level}`;
          if (xpEl) xpEl.textContent = `${lvlInfo.xpInCurrentLevel}/${lvlInfo.xpNeededForNext} XP`;
          if (streakEl) streakEl.textContent = data.streak || 0;
          if (barEl) barEl.style.width = `${lvlInfo.percent}%`;

          const xpElMob = document.getElementById('nav-dropdown-xp-mob');
          const lvlElMob = document.getElementById('nav-dropdown-level-mob');
          const streakElMob = document.getElementById('nav-dropdown-streak-mob');
          const barElMob = document.getElementById('nav-dropdown-bar-mob');

          if (lvlElMob) lvlElMob.textContent = `Poziom ${lvlInfo.level}`;
          if (xpElMob) xpElMob.textContent = `${lvlInfo.xpInCurrentLevel}/${lvlInfo.xpNeededForNext} XP`;
          if (streakElMob) streakElMob.textContent = data.streak || 0;
          if (barElMob) barElMob.style.width = `${lvlInfo.percent}%`;
        }
      };

      document.addEventListener('DOMContentLoaded', function() {
        if (typeof githubConfigUrl !== 'undefined') {
          fetch(githubConfigUrl)
            .then(res => res.json())
            .then(data => {
              window.InfoMatykaSDK.config = data;
              if (data.progressConfig) {
                if (data.progressConfig.xpRewards) globalConfig.xpRewards = data.progressConfig.xpRewards;
                if (data.progressConfig.achievements) globalConfig.achievements = data.progressConfig.achievements;
              }
              if (data.postNotificationBanner) {
                window.InfoMatykaSDK.renderPostBanner(data.postNotificationBanner);
              }
              var pageBannerConfig = data.pageNotificationBanner || {
                active: true,
                type: 'danger',
                icon: 'fa-shield-virus',
                text: '<strong>ALERT BEZPIECZEŃSTWA:</strong> Wykryto próbę naruszenia integralności serwisu (potencjalne zhakowanie strony). Ze względów bezpieczeństwa zalecamy pilną zmianę hasła do swojego konta.',
                link: 'https://www.infomatyka.pl/p/moje-konto.html',
                linkText: 'Zmień hasło',
                dismissible: true
              };
              if (pageBannerConfig && pageBannerConfig.active) {
                window.InfoMatykaSDK.renderPageBanner(pageBannerConfig);
              }
              window.dispatchEvent(new Event('infomatyka_config_loaded'));
              window.InfoMatykaSDK.updateNavbarDropdown();
            })
            .catch(err => {
              console.warn("Użyto domyślnej konfiguracji grywalizacji.", err);
              window.dispatchEvent(new Event('infomatyka_config_loaded'));
              window.InfoMatykaSDK.updateNavbarDropdown();
            });
        } else {
          window.dispatchEvent(new Event('infomatyka_config_loaded'));
          window.InfoMatykaSDK.updateNavbarDropdown();
        }
      });
    })();
