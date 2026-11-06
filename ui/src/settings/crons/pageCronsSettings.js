import { settingsSidebar } from "../settingsSidebar";
import { cronsList } from "./cronsList";

export function pageCronsSettings(route) {
    app.store.title = "Crons";

    const data = store({
        resetList: null,
    });

    function resetCronsList() {
        data.resetList = Date.now();
    }

    return t.div(
        { pbEvent: "pageCronsSettings", className: "page" },
        settingsSidebar(),
        t.div(
            { className: "page-content full-height" },
            t.header(
                { className: "page-header" },
                t.nav(
                    { className: "breadcrumbs" },
                    t.div({ className: "breadcrumb-item" }, "Settings"),
                    t.div({ className: "breadcrumb-item" }, () => app.store.title),
                ),
            ),
            t.div(
                { className: "wrapper m-b-base" },
                t.div(
                    { className: "flex gap-10 m-b-sm" },
                    t.div({ className: "txt-lg" }, "Registered app cron jobs"),
                    app.components.refreshButton({
                        className: "btn sm transparent secondary circle",
                        onclick: resetCronsList,
                    }),
                ),
                cronsList({
                    reset: () => data.resetList,
                }),
                t.div(
                    { className: "txt-sm txt-hint m-t-sm" },
                    "iglo.base has no app cron jobs of its own; only the built-in system jobs above run.",
                ),
            ),
            t.footer({ className: "page-footer" }, app.components.credits()),
        ),
    );
}
