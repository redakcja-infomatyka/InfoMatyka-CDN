/* InfoMatyka CDN | infomatyka-events-calendar.js | wydzielono z InfoMatyka_Website_Theme.html */
(function() {
                var eventsList = [
                  {
                    title: "Tydzień Z Tabliczką Mnożenia",
                    description: "Zapraszamy uczniów Szkoły Podstawowej nr 75 im. Powstańców Wielkopolskich do wspólnej zabawy! Czeka na Was aplikacja internetowa oraz wydarzenia offline na korytarzach szkoły.",
                    type: "Wydarzenie Szkolne",
                    location: "Szkoła i Online",
                    url: "https://www.infomatyka.pl/p/aplikacja-tabliczka-mnozenia.html",
                    startDate: "2025-11-21",
                    endDate: "2025-11-28"
                  },
                  {
                    title: "Matematyczny Kalendarz Adwentowy",
                    description: "Dołącz do Mikołaja i Elfów w codziennym odliczaniu do Świąt! Każdego dnia odblokuj nowe zadanie matematyczne ukryte w fabularnej otoczce. Wybierz swój poziom i pomóż w logistyce Bieguna Północnego, rozwiązując zagadki logiczne i rachunkowe.",
                    type: "Wyzwanie Online",
                    location: "Platforma InfoMatyka",
                    url: "https://www.infomatyka.pl/2025/12/wydarzenie-matematyczny-kalendarz-adwentowy.html",
                    startDate: "2025-12-01",
                    endDate: "2025-12-24"
                  },
                  {
                    title: "Informatyczny Kalendarz Adwentowy",
                    description: "Sprawdź swoją wiedzę o świecie komputerów! Codzienne zagadki dotyczące sprzętu, historii informatyki, systemów liczbowych (binarny, szesnastkowy) oraz cyberbezpieczeństwa. Idealne dla tych, którzy chcą zrozumieć, jak działają technologie, nie pisząc jeszcze kodu.",
                    type: "Wyzwanie Online",
                    location: "Platforma InfoMatyka",
                    url: "https://www.infomatyka.pl/2025/12/wydarzenie-informatyczny-kalendarz-adwentowy.html",
                    startDate: "2025-12-01",
                    endDate: "2025-12-24"
                  }
                ];

                function initCalendar() {
                    const container = document.getElementById('event-section-container');
                    const navButtons = document.getElementById('event-nav-buttons');
                    const prevBtn = document.getElementById('event-nav-prev');
                    const nextBtn = document.getElementById('event-nav-next');

                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    let activeEvents = [];
                    for (let i = 0; i < eventsList.length; i++) {
                        const evt = eventsList[i];
                        const start = new Date(evt.startDate);
                        const end = new Date(evt.endDate);
                        start.setHours(0, 0, 0, 0);
                        end.setHours(0, 0, 0, 0);

                        if (today >= start && today <= end) {
                        activeEvents.push(evt);
                        }
                    }

                    if (activeEvents.length === 0) {
                        return;
                    }

                    let currentEventIndex = 0;

                    function generateCalendar(activeEvent) {
                        const calendarGrid = document.getElementById('calendar-grid');
                        const calendarHeader = document.getElementById('calendar-month-year');
                        const start = new Date(activeEvent.startDate);
                        const monthNames = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];

                        const year = start.getFullYear();
                        const month = start.getMonth();
                        calendarHeader.textContent = monthNames[month] + " " + year;

                        const firstDayOfMonth = new Date(year, month, 1).getDay();
                        const startDay = firstDayOfMonth === 0 ? 7 : firstDayOfMonth;
                        const daysInMonth = new Date(year, month + 1, 0).getDate();

                        let html = '';
                        for (let i = 1; i < startDay; i++) {
                            html += `<div class="h-8"></div>`;
                        }
                        for (let day = 1; day <= daysInMonth; day++) {
                            let currentDayStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
                            let isEventDay = currentDayStr >= activeEvent.startDate && currentDayStr <= activeEvent.endDate;
                            let classes = "h-8 w-8 flex items-center justify-center rounded-full mx-auto text-gray-700 transition-colors cursor-default";
                            if (isEventDay) {
                            classes = "h-8 w-8 flex items-center justify-center rounded-full mx-auto bg-cyan-500 text-white font-bold shadow-md scale-110";
                            } else {
                            classes += " hover:bg-gray-200";
                            }

                            html += `<div class="${classes}">${day}</div>`;
                        }
                        calendarGrid.innerHTML = html;
                    }

                    function updateEventDisplay(index) {
                        const activeEvent = activeEvents[index];
                        const titleEl = document.getElementById('event-title');
                        const descEl = document.getElementById('event-desc');
                        const typeEl = document.getElementById('event-type-badge');
                        const locationEl = document.getElementById('event-location');
                        const dateDisplayEl = document.getElementById('event-date-display');
                        const linkEl = document.getElementById('event-link');

                        titleEl.textContent = activeEvent.title;
                        descEl.textContent = activeEvent.description;
                        typeEl.textContent = activeEvent.type;
                        locationEl.textContent = activeEvent.location;
                        linkEl.href = activeEvent.url;

                        const start = new Date(activeEvent.startDate);
                        const end = new Date(activeEvent.endDate);
                        const monthNames = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
                        const formatD = (d) => d.getDate() + ' ' + monthNames[d.getMonth()];

                        if (activeEvent.startDate === activeEvent.endDate) {
                            dateDisplayEl.textContent = formatD(start) + ' ' + start.getFullYear();
                        } else {
                            dateDisplayEl.textContent = formatD(start) + ' - ' + formatD(end) + ' ' + end.getFullYear();
                        }

                        generateCalendar(activeEvent);
                    }
                    container.classList.remove('hidden');
                    updateEventDisplay(currentEventIndex);

                    if (activeEvents.length > 1) {
                        navButtons.classList.remove('hidden');

                        prevBtn.addEventListener('click', function() {
                            currentEventIndex = (currentEventIndex === 0) ? activeEvents.length - 1 : currentEventIndex - 1;
                            updateEventDisplay(currentEventIndex);
                        });

                        nextBtn.addEventListener('click', function() {
                            currentEventIndex = (currentEventIndex === activeEvents.length - 1) ? 0 : currentEventIndex + 1;
                            updateEventDisplay(currentEventIndex);
                        });
                    }
                }
                document.addEventListener('DOMContentLoaded', function() {
                    if(typeof githubConfigUrl !== 'undefined') {
                        fetch(githubConfigUrl)
                        .then(res => res.json())
                        .then(data => {
                            if(data.events) {
                                eventsList = data.events;
                            }
                            initCalendar();
                        })
                        .catch(err => {
                            console.error('Blad pobierania wydarzen:', err);
                            initCalendar();
                        });
                    } else {
                        initCalendar();
                    }
                });
              })();
