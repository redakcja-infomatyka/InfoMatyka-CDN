/* InfoMatyka CDN | infomatyka-header-widgets.js | wydzielono z InfoMatyka_Website_Theme.html */
(function() {
                          var config = {
                            aktywnyWidget: 'random',
                            widgetyDoLosowania: ['zadanieDnia'],

                            info: {
                                tytul: "WAŻNA INFORMACJA",
                                tresc: "Już wkrótce opublikujemy pełne omówienie arkusza z egzaminu ósmoklasisty. Bądźcie czujni!",
                                linkPrzycisku: "/p/egzamin-osmoklasisty.html",
                                tekstPrzycisku: "Zobacz Więcej"
                            },
                            zadania: [
                              { pytanie: "Jaka jest kolejna liczba w ciągu: 1, 1, 2, 3, 5, 8...?", odpowiedz: "To ciąg Fibonacciego. Następna liczba to 13 (5 + 8)." },
                              { pytanie: "Ile wynosi suma kątów wewnętrznych w trójkącie?", odpowiedz: "Suma kątów w każdym trójkącie wynosi 180 stopni." },
                              { pytanie: "Co w informatyce oznacza skrót HTML?", odpowiedz: "HyperText Markup Language (Hipertekstowy Język Znaczników)." }
                            ],
                            liczniki: {
                                matura: {
                                    tytul: "Do Egzaminu Maturalnego 2026 Zostało:",
                                    data: "May 5, 2026 09:00:00",
                                    wiadomosc: "Powodzenia Na Maturze!",
                                    kolor: "#745DC5"
                                },
                                osmoklasista: {
                                    tytul: "Do Egzaminu Ósmoklasisty 2026 Zostało:",
                                    data: "May 12, 2026 09:00:00",
                                    wiadomosc: "Powodzenia Na Egzaminie!",
                                    kolor: "#11800A"
                                }
                            },
                            lekcja: {
                                link: "https://www.twojastrona.pl/p/lekcja-na-zywo.html",
                                tekst: "Lekcja Na Żywo - Kliknij, Aby Dołączyć"
                            }
                          };

                          function renderWidget(cfg) {
                            var now = new Date();

                            window.toggleWidgetCollapse = function(el) {
                              var content = el.nextElementSibling;
                              var icon = el.querySelector('.collapse-icon');
                              if (content.style.maxHeight && content.style.maxHeight !== "0px") {
                                if (content.style.maxHeight === "none") {
                                  content.style.maxHeight = content.scrollHeight + "px";
                                  content.offsetHeight;
                                }
                                content.style.maxHeight = "0px";
                                if (icon) icon.style.transform = 'rotate(0deg)';
                              } else {
                                content.style.maxHeight = content.scrollHeight + "px";
                                if (icon) icon.style.transform = 'rotate(180deg)';
                                
                                var onTransitionEnd = function(e) {
                                  if (e.target !== content) return;
                                  if (content.style.maxHeight && content.style.maxHeight !== "0px") {
                                    content.style.maxHeight = "none";
                                  }
                                  content.removeEventListener('transitionend', onTransitionEnd);
                                };
                                content.addEventListener('transitionend', onTransitionEnd);
                              }
                            };

                            function parseDateSafe(dateStr) {
                              if (!dateStr) return null;
                              var formatted = dateStr.trim();
                              if (formatted.match(/^\d{4}-\d{2}-\d{2}$/)) {
                                return new Date(formatted.replace(/-/g, '/'));
                              }
                              if (formatted.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/)) {
                                return new Date(formatted.replace(/-/g, '/'));
                              }
                              return new Date(formatted);
                            }

                            var activeInfo = [];
                            if (cfg.info) {
                              var infoArray = Array.isArray(cfg.info) ? cfg.info : [cfg.info];
                              activeInfo = infoArray.filter(function(item) {
                                var showFrom = parseDateSafe(item.visibleFrom);
                                var showUntil = parseDateSafe(item.visibleUntil || item.endDate);

                                if (showFrom && now < showFrom) return false;
                                if (showUntil) {
                                  if ((item.visibleUntil || item.endDate).trim().match(/^\d{4}-\d{2}-\d{2}$/)) {
                                    showUntil.setHours(23, 59, 59, 999);
                                  }
                                  if (now > showUntil) return false;
                                }
                                return true;
                              });
                            }

                            var activeLessons = [];
                            if (cfg.lekcja) {
                              var lessonArray = Array.isArray(cfg.lekcja) ? cfg.lekcja : [cfg.lekcja];
                              activeLessons = lessonArray.filter(function(item) {
                                var showFrom = parseDateSafe(item.visibleFrom);
                                var showUntil = parseDateSafe(item.visibleUntil || item.endDate);

                                if (showFrom && now < showFrom) return false;
                                if (showUntil) {
                                  if ((item.visibleUntil || item.endDate).trim().match(/^\d{4}-\d{2}-\d{2}$/)) {
                                    showUntil.setHours(23, 59, 59, 999);
                                  }
                                  if (now > showUntil) return false;
                                }
                                return true;
                              });
                            }

                            if (cfg.info) {
                              if (Array.isArray(cfg.info)) {
                                cfg.info = activeInfo;
                              } else {
                                cfg.info = activeInfo[0] || null;
                              }
                            }
                            if (cfg.lekcja) {
                              if (Array.isArray(cfg.lekcja)) {
                                cfg.lekcja = activeLessons;
                              } else {
                                cfg.lekcja = activeLessons[0] || null;
                              }
                            }

                            var allowedWidgets = [];
                            if (cfg.widgetyDoLosowania) {
                              allowedWidgets = cfg.widgetyDoLosowania.filter(function(widgetName) {
                                if (widgetName === 'informacja') {
                                  return activeInfo.length > 0;
                                }
                                if (widgetName === 'lekcjaNaZywo') {
                                  return activeLessons.length > 0;
                                }
                                return true;
                              });
                            }

                            var aktywny = cfg.aktywnyWidget;
                            if (aktywny === 'random' && allowedWidgets.length > 0) {
                              var losowyIndeks = Math.floor(Math.random() * allowedWidgets.length);
                              aktywny = allowedWidgets[losowyIndeks];
                            }

                            var wspolnyStyl = `<style>
                              /* Desktop layout helper to align widgets beautifully to the right */
                              @media (min-width: 768px) {
                                .lessons-widget-container, .info-widget-container, .problem-dnia-widget, .countdown-widget {
                                  max-width: 480px;
                                  width: 100%;
                                  margin-left: auto;
                                }
                              }
                              /* Responsive styles for container padding */
                              @media (max-width: 640px) {
                                .lessons-widget-container, .info-widget-container, .problem-dnia-widget, .countdown-widget {
                                  padding: 12px !important;
                                }
                                .lesson-join-button, .info-widget-button {
                                  width: 100% !important;
                                  text-align: center !important;
                                  box-sizing: border-box !important;
                                }
                                .countdown-item .number {
                                  font-size: 24px !important;
                                }
                              }
                              /* Nested collapsible items responsive inner padding */
                              .nested-collapsible-inner {
                                padding-top: 10px;
                                padding-left: 32px;
                                text-align: left;
                              }
                              @media (max-width: 640px) {
                                .nested-collapsible-inner {
                                  padding-left: 16px !important;
                                }
                              }
                              /* General accordion styles */
                              .collapsible-header {
                                cursor: pointer;
                                transition: background-color 0.2s;
                              }
                              .collapsible-header:hover {
                                background-color: rgba(0, 0, 0, 0.02);
                              }
                              .collapsible-content {
                                max-height: 0px;
                                overflow: hidden;
                                transition: max-height 0.3s ease-out;
                              }
                            </style>`;

                            var kodDoWyswietlenia = wspolnyStyl;

                            switch (aktywny) {
                              case 'informacja':
                                  if (Array.isArray(cfg.info)) {
                                      if (cfg.info.length === 0) {
                                          kodDoWyswietlenia = '';
                                          break;
                                      }
                                      var itemsHTML = cfg.info.map((item, idx) => {
                                          var start = parseDateSafe(item.startDate);
                                          var end = parseDateSafe(item.endDate);

                                          var currentBtnText = item.tekstPrzycisku;
                                          var currentLink = item.linkPrzycisku;

                                          if (start && now < start) {
                                              currentBtnText = item.tekstPrzyciskuPrzed || currentBtnText;
                                              currentLink = item.linkPrzed || currentLink;
                                          } else if (start && end && now >= start && now <= end) {
                                              currentBtnText = item.tekstPrzyciskuWTrakcie || currentBtnText;
                                              currentLink = item.linkWTrakcie || currentLink;
                                          } else if (end && now > end) {
                                              currentBtnText = item.tekstPrzyciskuPo || currentBtnText;
                                              currentLink = item.linkPo || currentLink;
                                          }

                                          var btnHTML = '';
                                          if (currentLink && currentBtnText) {
                                              btnHTML = `<a href="${currentLink}" class="info-widget-button" style="margin-top:10px;">${currentBtnText}</a>`;
                                          }
                                          var borderStyle = idx > 0 ? 'border-top: 1px solid #dee2e6; padding-top: 15px; margin-top: 15px;' : '';
                                          var dateHTML = item.data ? `<div style="font-size:11px; color:#6b7280; margin-bottom: 5px;"><i class="fa fa-calendar-o" style="margin-right: 5px;"></i>${item.data}</div>` : '';

                                          if (item.collapsible) {
                                              return `<div style="${borderStyle}">
                                                  <div class="info-widget-header collapsible-header" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                                                      <div style="display: flex; align-items: center;">
                                                          <i class="fa fa-bullhorn" style="margin-right: 10px; color: #1b7d91;"></i>
                                                          <span style="font-weight: 700; color: #343a40;">${item.tytul}</span>
                                                      </div>
                                                      <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s;"></i>
                                                  </div>
                                                  <div class="collapsible-content" style="max-height: 0px; overflow: hidden; transition: max-height 0.3s ease-out;">
                                                      <div style="padding-top: 5px; padding-bottom: 5px;">
                                                          ${dateHTML}
                                                          <div class="info-widget-content"><p style="margin:0;">${item.tresc}</p>${btnHTML}</div>
                                                      </div>
                                                  </div>
                                              </div>`;
                                          } else {
                                              return `<div style="${borderStyle}">
                                                  <div class="info-widget-header" style="margin-bottom: 6px;"><i class="fa fa-bullhorn"></i><span>${item.tytul}</span></div>
                                                  ${dateHTML}
                                                  <div class="info-widget-content"><p style="margin:0;">${item.tresc}</p>${btnHTML}</div>
                                              </div>`;
                                          }
                                      }).join('');

                                      var infoContainerStyles = `<style>.info-widget-container{background-color:#f8f9fa;border:1px solid #dee2e6;border-left:5px solid #1b7d91;padding:20px;margin-bottom:20px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,.05)}.info-widget-header{display:flex;align-items:center;font-size:16px;font-weight:700;color:#343a40;margin-bottom:10px}.info-widget-header .fa{font-size:20px;color:#1b7d91;margin-right:10px}.info-widget-content{font-size:14px;color:#374151;line-height:1.6}.info-widget-button{display:inline-block;background-color:#1b7d91;color:#fff!important;padding:8px 15px;border-radius:4px;text-decoration:none!important;margin-top:15px;font-weight:700;transition:background-color .2s}.info-widget-button:hover,.info-widget-button:visited:hover{background-color:#115e6e;color:#fff!important}.info-widget-button:visited{color:#fff!important}</style>`;

                                      if (cfg.infoCollapsible) {
                                          kodDoWyswietlenia += `${infoContainerStyles}
                                          <div class="info-widget-container">
                                              <div class="collapsible-header info-widget-header" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 0; padding-bottom: 0; justify-content: space-between; display: flex; align-items: center; width: 100%;">
                                                  <div style="display: flex; align-items: center; gap: 8px;">
                                                      <i class="fa fa-bullhorn"></i>
                                                      <span>Ważne Informacje</span>
                                                  </div>
                                                  <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s;"></i>
                                              </div>
                                              <div class="collapsible-content">
                                                  <div style="padding-top: 15px; border-top: 2px solid #1b7d91; margin-top: 10px;">
                                                      ${itemsHTML}
                                                  </div>
                                              </div>
                                          </div>`;
                                      } else {
                                          kodDoWyswietlenia += `${infoContainerStyles}<div class="info-widget-container">${itemsHTML}</div>`;
                                      }
                                  } else {
                                      if (!cfg.info) {
                                          kodDoWyswietlenia = '';
                                          break;
                                      }
                                      var start = parseDateSafe(cfg.info.startDate);
                                      var end = parseDateSafe(cfg.info.endDate);
                                      var currentBtnText = cfg.info.tekstPrzycisku;
                                      var currentLink = cfg.info.linkPrzycisku;

                                      if (start && now < start) {
                                          currentBtnText = cfg.info.tekstPrzyciskuPrzed || currentBtnText;
                                          currentLink = cfg.info.linkPrzed || currentLink;
                                      } else if (start && end && now >= start && now <= end) {
                                          currentBtnText = cfg.info.tekstPrzyciskuWTrakcie || currentBtnText;
                                          currentLink = cfg.info.linkWTrakcie || currentLink;
                                      } else if (end && now > end) {
                                          currentBtnText = cfg.info.tekstPrzyciskuPo || currentBtnText;
                                          currentLink = cfg.info.linkPo || currentLink;
                                      }

                                      var przyciskHTML = '';
                                      if (currentLink && currentBtnText) {
                                          przyciskHTML = `<a href="${currentLink}" class="info-widget-button">${currentBtnText}</a>`;
                                      }
                                      var dateHTML = cfg.info.data ? `<div style="font-size:11px; color:#6b7280; margin-bottom: 5px;"><i class="fa fa-calendar-o" style="margin-right: 5px;"></i>${cfg.info.data}</div>` : '';
                                      
                                      var infoContainerStyles = `<style>.info-widget-container{background-color:#f8f9fa;border:1px solid #dee2e6;border-left:5px solid #1b7d91;padding:20px;margin-bottom:20px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,.05)}.info-widget-header{display:flex;align-items:center;font-size:16px;font-weight:700;color:#343a40;margin-bottom:10px}.info-widget-header .fa{font-size:20px;color:#1b7d91;margin-right:10px}.info-widget-content{font-size:14px;color:#374151;line-height:1.6}.info-widget-button{display:inline-block;background-color:#1b7d91;color:#fff!important;padding:8px 15px;border-radius:4px;text-decoration:none!important;margin-top:15px;font-weight:700;transition:background-color .2s}.info-widget-button:hover,.info-widget-button:visited:hover{background-color:#115e6e;color:#fff!important}.info-widget-button:visited{color:#fff!important}</style>`;
                                      var itemContentHTML = `<div class="info-widget-content"><p style="margin:0;">${cfg.info.tresc}</p>${przyciskHTML}</div>`;
                                      
                                      if (cfg.infoCollapsible) {
                                          kodDoWyswietlenia += `${infoContainerStyles}
                                          <div class="info-widget-container">
                                              <div class="collapsible-header info-widget-header" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 0; padding-bottom: 0; justify-content: space-between; display: flex; align-items: center; width: 100%;">
                                                  <div style="display: flex; align-items: center; gap: 8px;">
                                                      <i class="fa fa-bullhorn"></i>
                                                      <span>${cfg.info.tytul}</span>
                                                  </div>
                                                  <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s;"></i>
                                              </div>
                                              <div class="collapsible-content">
                                                  <div style="padding-top: 15px; border-top: 2px solid #1b7d91; margin-top: 10px;">
                                                      ${dateHTML}
                                                      ${itemContentHTML}
                                                  </div>
                                              </div>
                                          </div>`;
                                      } else {
                                          kodDoWyswietlenia += `${infoContainerStyles}<div class="info-widget-container"><div class="info-widget-header"><i class="fa fa-bullhorn"></i><span>${cfg.info.tytul}</span></div>${dateHTML}${itemContentHTML}</div>`;
                                      }
                                  }
                                 break;

                               case 'zadanieDnia':
                                 var dzisiaj = new Date(), poczatekRoku = new Date(dzisiaj.getFullYear(), 0, 0);
                                 var dzienRoku = Math.floor((dzisiaj - poczatekRoku) / (1e3 * 60 * 60 * 24));
                                 var wybraneZadanie = cfg.zadania[dzienRoku % cfg.zadania.length];
                                 if(!wybraneZadanie) wybraneZadanie = cfg.zadania[0];
                                 
                                 var taskWidgetStyles = `<style>
                                     .problem-dnia-widget{background:#fff;border:1px solid #e9e9e9;padding:20px;margin-bottom:20px;border-radius:8px;}
                                     .problem-dnia-header{font-size:16px;font-weight:700;color:#474747;margin:0 0 15px 0;padding-bottom:10px;border-bottom:2px solid #48b8cf;display:flex;align-items:center;gap:8px;}
                                     .problem-dnia-pytanie{font-style:italic;color:#555;margin-bottom:15px}
                                     .problem-dnia-przycisk{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:#48b8cf;font-weight:700;text-decoration:none!important}
                                     .problem-dnia-przycisk:hover{color:#333}
                                     .problem-dnia-status{display:flex;align-items:center;gap:8px;color:#15803d;font-weight:700}
                                 </style>`;

                                 if (cfg.zadanieCollapsible) {
                                     kodDoWyswietlenia += `${taskWidgetStyles}
                                     <div class="problem-dnia-widget">
                                         <div class="collapsible-header problem-dnia-header" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 0; border-bottom: none; padding-bottom: 0; justify-content: space-between; display: flex; align-items: center; width: 100%;">
                                             <div style="display: flex; align-items: center; gap: 8px;">
                                                 <i class="fa fa-puzzle-piece" style="color: #48b8cf;"></i>
                                                 <span>Zadanie Dnia</span>
                                             </div>
                                             <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s;"></i>
                                         </div>
                                         <div class="collapsible-content">
                                             <div style="padding-top: 15px; border-top: 2px solid #48b8cf; margin-top: 10px;">
                                                 <div class="problem-dnia-pytanie">${wybraneZadanie.pytanie}</div>
                                                 <a class="problem-dnia-przycisk im-daily-task-link" href="/p/zadanie-dnia.html"><i class="fa fa-arrow-right"></i><span>Rozwiąż zadanie</span></a>
                                             </div>
                                         </div>
                                     </div>`;
                                 } else {
                                     kodDoWyswietlenia += `${taskWidgetStyles}
                                     <div class="problem-dnia-widget">
                                         <h3 class="problem-dnia-header"><i class="fa fa-puzzle-piece"></i>Zadanie Dnia</h3>
                                         <div class="problem-dnia-pytanie">${wybraneZadanie.pytanie}</div>
                                         <a class="problem-dnia-przycisk im-daily-task-link" href="/p/zadanie-dnia.html"><i class="fa fa-arrow-right"></i><span>Rozwiąż zadanie</span></a>
                                     </div>`;
                                 }
                                 setTimeout(function() {
                                   if (!window.InfoMatykaSDK) return;
                                   document.querySelectorAll('.im-daily-task-link').forEach(function(link) {
                                     if (window.InfoMatykaSDK.isDailyTaskCompleted()) {
                                       link.className = 'problem-dnia-status';
                                       link.removeAttribute('href');
                                       link.innerHTML = '<i class="fa fa-check-circle"></i><span>Zadanie Wykonane</span>';
                                     }
                                   });
                                 }, 0);
                                 break;

                               case 'licznikMatura':
                               case 'licznikOsmoklasisty':
                                 var licznikConfig = (aktywny === 'licznikMatura') ?
                                   { ...cfg.liczniki.matura, id: 'matura' } :
                                   { ...cfg.liczniki.osmoklasista, id: 'osmoklasisty' };
                                 
                                 var countdownStyles = `<style>
                                     .countdown-widget{background-color:${licznikConfig.kolor};color:#fff;border-radius:8px;padding:20px;margin-bottom:20px;text-align:center;box-shadow:0 4px 10px rgba(0,0,0,.1)}
                                     .countdown-widget-title{font-size:16px;font-weight:700;color:#fff;margin:0 0 20px 0;padding-bottom:15px;border-bottom:1px solid hsla(0,0%,100%,.2);display:flex;align-items:center;gap:8px;}
                                     #countdown-timer-${licznikConfig.id}{display:flex;justify-content:space-around;align-items:center}
                                     .countdown-item{display:flex;flex-direction:column;align-items:center}
                                     .countdown-item .number{font-size:32px;font-weight:700;line-height:1}
                                     .countdown-item .label{font-size:12px;text-transform:uppercase;opacity:.8;margin-top:5px}
                                     #countdown-end-message-${licznikConfig.id}{font-size:18px;font-weight:700;color:#fff;padding-top:10px}
                                 </style>`;

                                 if (cfg.licznikiCollapsible) {
                                     kodDoWyswietlenia += `${countdownStyles}
                                     <div class="countdown-widget">
                                         <div class="collapsible-header countdown-widget-title" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 0; border-bottom: none; padding-bottom: 0; justify-content: space-between; display: flex; align-items: center; width: 100%;">
                                             <div style="display: flex; align-items: center; gap: 8px;">
                                                 <i class="fa fa-clock-o"></i>
                                                 <span>${licznikConfig.tytul}</span>
                                             </div>
                                             <i class="fa fa-chevron-down collapse-icon" style="color: hsla(0,0%,100%,.8); transition: transform 0.2s;"></i>
                                         </div>
                                         <div class="collapsible-content">
                                             <div style="padding-top: 15px; border-top: 1px solid hsla(0,0%,100%,.2); margin-top: 15px;">
                                                 <div id="countdown-timer-${licznikConfig.id}"><div class="countdown-item"><span class="number" id="days-${licznikConfig.id}"></span><div class="label">Dni</div></div><div class="countdown-item"><span class="number" id="hours-${licznikConfig.id}"></span><div class="label">Godzin</div></div><div class="countdown-item"><span class="number" id="minutes-${licznikConfig.id}"></span><div class="label">Minut</div></div><div class="countdown-item"><span class="number" id="seconds-${licznikConfig.id}"></span><div class="label">Sekund</div></div></div>
                                                 <div id="countdown-end-message-${licznikConfig.id}" style="display:none;">${licznikConfig.wiadomosc}</div>
                                             </div>
                                         </div>
                                     </div>`;
                                 } else {
                                     kodDoWyswietlenia += `${countdownStyles}
                                     <div class="countdown-widget">
                                         <h3 class="countdown-widget-title"><i class="fa fa-clock-o"></i>${licznikConfig.tytul}</h3>
                                         <div id="countdown-timer-${licznikConfig.id}"><div class="countdown-item"><span class="number" id="days-${licznikConfig.id}"></span><div class="label">Dni</div></div><div class="countdown-item"><span class="number" id="hours-${licznikConfig.id}"></span><div class="label">Godzin</div></div><div class="countdown-item"><span class="number" id="minutes-${licznikConfig.id}"></span><div class="label">Minut</div></div><div class="countdown-item"><span class="number" id="seconds-${licznikConfig.id}"></span><div class="label">Sekund</div></div></div>
                                         <div id="countdown-end-message-${licznikConfig.id}" style="display:none;">${licznikConfig.wiadomosc}</div>
                                     </div>`;
                                 }

                                 kodDoWyswietlenia += `<script>var countDownDate_${licznikConfig.id}=new Date("${licznikConfig.data}").getTime(),x_${licznikConfig.id}=setInterval(function(){var e=(new Date).getTime(),t=countDownDate_${licznikConfig.id}-e,o=Math.floor(t/864e5),n=Math.floor(t%864e5/36e5),d=Math.floor(t%36e5/6e4),i=Math.floor(t%6e4/1e3);var elD=document.getElementById("days-${licznikConfig.id}"),elH=document.getElementById("hours-${licznikConfig.id}"),elM=document.getElementById("minutes-${licznikConfig.id}"),elS=document.getElementById("seconds-${licznikConfig.id}"); if(elD) elD.innerHTML=o; if(elH) elH.innerHTML=n; if(elM) elM.innerHTML=d; if(elS) elS.innerHTML=i;if(t<0){clearInterval(x_${licznikConfig.id});if(document.getElementById("countdown-timer-${licznikConfig.id}")) document.getElementById("countdown-timer-${licznikConfig.id}").style.display="none";if(document.getElementById("countdown-end-message-${licznikConfig.id}")) document.getElementById("countdown-end-message-${licznikConfig.id}").style.display="block"}},1e3);<\/script>`;
                                 break;

                               case 'lekcjaNaZywo':
                                  if (Array.isArray(cfg.lekcja)) {
                                      if (cfg.lekcja.length === 0) {
                                          kodDoWyswietlenia = '';
                                          break;
                                      }
                                      var lessonsHTML = cfg.lekcja.map((lesson, idx) => {
                                          var liveHTML = '';
                                          var iconHTML = '<i class="fa fa-calendar-check-o text-cyan-600 text-lg mr-3"></i>';
                                          
                                          var start = parseDateSafe(lesson.startDate);
                                          var end = parseDateSafe(lesson.endDate);
                                          
                                          var currentBtnText = lesson.tekstPrzycisku;
                                          var currentLink = lesson.link;
                                          var state = 'upcoming';
                                          
                                          if (start && now < start) {
                                              state = 'upcoming';
                                              currentBtnText = lesson.tekstPrzyciskuPrzed || currentBtnText || 'Zarezerwuj miejsce';
                                              currentLink = lesson.linkPrzed || currentLink;
                                          } else if (start && end && now >= start && now <= end) {
                                              state = 'live';
                                              currentBtnText = lesson.tekstPrzyciskuWTrakcie || currentBtnText || 'Dołącz (Live)';
                                              currentLink = lesson.linkWTrakcie || currentLink;
                                          } else if (end && now > end) {
                                              state = 'finished';
                                              currentBtnText = lesson.tekstPrzyciskuPo || currentBtnText || 'Zobacz nagranie';
                                              currentLink = lesson.linkPo || currentLink;
                                          }

                                          if (state === 'live') {
                                              liveHTML = '<div class="live-indicator inline-block bg-red-600 w-3 h-3 rounded-full mr-2" style="animation: pulse-live 1.5s infinite;"></div>';
                                              iconHTML = '<i class="fa fa-video-camera text-red-600 text-lg mr-3"></i>';
                                          } else if (state === 'finished') {
                                              iconHTML = '<i class="fa fa-history text-gray-500 text-lg mr-3"></i>';
                                          } else {
                                              iconHTML = '<i class="fa fa-calendar-check-o text-cyan-600 text-lg mr-3"></i>';
                                          }

                                          var dateHTML = lesson.data ? `<div style="font-size:12px; color:#4b5563; font-weight: 600; margin-bottom: 3px; display:flex; align-items:center;">${liveHTML}${lesson.data}</div>` : '';
                                          var descHTML = lesson.info ? `<div style="font-size:13px; color:#6b7280; margin-bottom: 10px; line-height: 1.4;">${lesson.info}</div>` : '';
                                          var btnHTML = currentLink ? `<a href="${currentLink}" class="lesson-join-button ${state === 'live' ? 'live-btn' : (state === 'finished' ? 'finished-btn' : '')}">${currentBtnText}</a>` : '';
                                          var borderStyle = idx > 0 ? 'border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 16px;' : '';
                                          
                                          if (lesson.collapsible) {
                                              return `<div style="${borderStyle} display: flex; flex-direction: column;">
                                                  <div class="collapsible-header" onclick="toggleWidgetCollapse(this)" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; width: 100%;">
                                                      <div style="display: flex; align-items: center; flex-grow: 1; text-align: left;">
                                                          ${iconHTML}
                                                          <div>
                                                              <div style="font-size:15px; font-weight: 700; color:#1f2937;">${lesson.tekst}</div>
                                                              ${dateHTML}
                                                          </div>
                                                      </div>
                                                      <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s; margin-left: 10px;"></i>
                                                  </div>
                                                  <div class="collapsible-content">
                                                      <div class="nested-collapsible-inner">
                                                          ${descHTML}
                                                          ${btnHTML}
                                                      </div>
                                                  </div>
                                              </div>`;
                                          } else {
                                              return `<div style="${borderStyle} display: flex; align-items: flex-start;">
                                                  ${iconHTML}
                                                  <div style="flex-grow: 1; text-align: left;">
                                                      <div style="font-size:15px; font-weight: 700; color:#1f2937; margin-bottom: 4px;">${lesson.tekst}</div>
                                                      ${dateHTML}
                                                      ${descHTML}
                                                      ${btnHTML}
                                                  </div>
                                              </div>`;
                                          }
                                      }).join('');
                                      
                                      var lessonsContainerStyles = `<style>
                                          .lessons-widget-container {
                                              background-color: #ffffff;
                                              border: 1px solid #e5e7eb;
                                              padding: 20px;
                                              margin-bottom: 20px;
                                              border-radius: 8px;
                                              box-shadow: 0 4px 10px rgba(0,0,0,.05);
                                          }
                                          .lessons-widget-header {
                                              font-size: 16px;
                                              font-weight: 700;
                                              color: #1f2937;
                                              margin-bottom: 16px;
                                              border-bottom: 2px solid #e53935;
                                              padding-bottom: 8px;
                                              display: flex;
                                              align-items: center;
                                              gap: 8px;
                                              text-align: left;
                                          }
                                          .lesson-join-button {
                                              display: inline-block;
                                              background-color: #1b7d91;
                                              color: #fff!important;
                                              padding: 6px 14px;
                                              font-size: 13px;
                                              border-radius: 6px;
                                              text-decoration: none!important;
                                              font-weight: 700;
                                              transition: background-color .2s, transform .2s;
                                          }
                                          .lesson-join-button:hover {
                                              background-color: #115e6e;
                                              transform: translateY(-1px);
                                          }
                                          .lesson-join-button.live-btn {
                                              background-color: #e53935;
                                          }
                                          .lesson-join-button.live-btn:hover {
                                              background-color: #c62828;
                                          }
                                          .lesson-join-button.finished-btn {
                                              background-color: #6b7280;
                                          }
                                          .lesson-join-button.finished-btn:hover {
                                              background-color: #4b5563;
                                          }
                                          @keyframes pulse-live {
                                              0% { box-shadow: 0 0 0 0 rgba(229,57,53,.7); }
                                              70% { box-shadow: 0 0 0 8px rgba(229,57,53,0); }
                                              100% { box-shadow: 0 0 0 0 rgba(229,57,53,0); }
                                          }
                                          @media (max-width: 640px) { .lessons-widget-container { padding: 15px; } }
                                      </style>`;

                                      if (cfg.lekcjaCollapsible) {
                                          kodDoWyswietlenia += `${lessonsContainerStyles}
                                          <div class="lessons-widget-container">
                                              <div class="collapsible-header lessons-widget-header" onclick="toggleWidgetCollapse(this)" style="margin-bottom: 0; border-bottom: none; padding-bottom: 0; justify-content: space-between; display: flex; align-items: center; width: 100%;">
                                                  <div style="display: flex; align-items: center; gap: 8px;">
                                                      <i class="fa fa-television text-red-600"></i>
                                                      <span>Lekcje i Spotkania Online</span>
                                                  </div>
                                                  <i class="fa fa-chevron-down collapse-icon" style="color: #6b7280; transition: transform 0.2s;"></i>
                                              </div>
                                              <div class="collapsible-content">
                                                  <div style="padding-top: 16px; border-top: 2px solid #e53935; margin-top: 12px;">
                                                      ${lessonsHTML}
                                                  </div>
                                              </div>
                                          </div>`;
                                      } else {
                                          kodDoWyswietlenia += `${lessonsContainerStyles}
                                          <div class="lessons-widget-container">
                                              <div class="lessons-widget-header">
                                                  <i class="fa fa-television text-red-600"></i>
                                                  <span>Lekcje i Spotkania Online</span>
                                              </div>
                                              ${lessonsHTML}
                                          </div>`;
                                      }
                                  } else {
                                      if (!cfg.lekcja) {
                                          kodDoWyswietlenia = '';
                                          break;
                                      }
                                      kodDoWyswietlenia += `<style>.live-lesson-banner{display:flex;align-items:center;justify-content:center;background-color:#e53935;color:#fff;padding:15px 20px;border-radius:8px;text-decoration:none!important;font-family:'Roboto',sans-serif;font-size:16px;font-weight:700;text-align:center;box-shadow:0 4px 15px rgba(0,0,0,.2);transition:transform .3s ease,background-color .3s ease;margin-top:10px}.live-lesson-banner:hover{background-color:#c62828;transform:translateY(-2px);color:#fff}.live-lesson-banner:visited{color:#fff}.live-lesson-banner .live-indicator{width:12px;height:12px;background-color:#fff;border-radius:50%;margin-right:12px;animation:pulse 1.5s infinite}@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.7)}70%{box-shadow:0 0 0 10px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}@media (max-width:960px){.live-lesson-banner{width:100%;box-sizing:border-box}}</style><a class="live-lesson-banner" href="${cfg.lekcja.link}"><div class="live-indicator"></div><span>${cfg.lekcja.tekst}</span></a>`;
                                  }
                                 break;
                            }

                            var container = document.getElementById('header-widget-content');
                            if(container) {
                                container.innerHTML = kodDoWyswietlenia;

                                var scripts = container.getElementsByTagName("script");
                                for(var i=0; i<scripts.length; i++) {
                                    eval(scripts[i].innerText);
                                }
                            }
                          }

                          if (typeof githubConfigUrl !== 'undefined') {
                             fetch(githubConfigUrl)
                               .then(response => response.json())
                               .then(data => {
                                   if(data.headerWidget) {
                                       if(data.headerWidget.aktywnyWidget) config.aktywnyWidget = data.headerWidget.aktywnyWidget;
                                       if(data.headerWidget.widgetyDoLosowania) config.widgetyDoLosowania = data.headerWidget.widgetyDoLosowania;
                                       if(data.headerWidget.info) config.info = data.headerWidget.info;
                                       if(data.headerWidget.zadania) config.zadania = data.headerWidget.zadania;
                                       if(data.headerWidget.liczniki) config.liczniki = data.headerWidget.liczniki;
                                       if(data.headerWidget.lekcja) config.lekcja = data.headerWidget.lekcja;
                                       if(data.headerWidget.hasOwnProperty('infoCollapsible')) config.infoCollapsible = data.headerWidget.infoCollapsible;
                                       if(data.headerWidget.hasOwnProperty('lekcjaCollapsible')) config.lekcjaCollapsible = data.headerWidget.lekcjaCollapsible;
                                       if(data.headerWidget.hasOwnProperty('zadanieCollapsible')) config.zadanieCollapsible = data.headerWidget.zadanieCollapsible;
                                       if(data.headerWidget.hasOwnProperty('licznikiCollapsible')) config.licznikiCollapsible = data.headerWidget.licznikiCollapsible;
                                   }
                                   renderWidget(config);
                               })
                               .catch(err => {
                                   console.error("Błąd pobierania konfiguracji widgetu:", err);
                                   renderWidget(config);
                               });
                          } else {
                              renderWidget(config);
                          }

                        })();
