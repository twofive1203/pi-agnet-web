# Architecture Decisions

Record important technical decisions here when a change establishes a durable constraint, tradeoff, or compatibility rule. Prefer one Markdown file per decision with a short descriptive name.

- [`automation-scheduler.md`](automation-scheduler.md) — Scheduled Agent Automation authority, scheduling, execution, and retention boundaries.
- [`desktop-pet-task-observer.md`](desktop-pet-task-observer.md) — Independent Windows 10/11 pet + Activity tray that attaches to an already running local service through a privacy-bounded multi-source observer.
- [`desktop-pet-quick-session.md`](desktop-pet-quick-session.md) — User-initiated first-message session start from the Activity tray, using a scoped desktop-control token separate from the read-only observer.
- [`desktop-pet-bubble-chrome.md`](desktop-pet-bubble-chrome.md) — Q-version comic-bubble chrome for the caption, hover chips, Activity tray, and settings; presentation-only, no observer/window-size change.
