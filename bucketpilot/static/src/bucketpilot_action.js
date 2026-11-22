import { Component, useExternalListener, useRef, xml } from "@odoo/owl";
import { router } from "@web/core/browser/router";
import { registry } from "@web/core/registry";

const HOME = "/bucketpilot";
const ID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const PAGE = new RegExp(
    `^${HOME}(?:/(?:connection|buckets|backups|schedules(?:/${ID}/edit)?|history(?:/${ID}(?:/cancel|/resume)?)?))?$`
);

function pagePath(value) {
    if (typeof value !== "string" || !value.startsWith(HOME) || value.length > 2048) {
        return null;
    }
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin && PAGE.test(url.pathname)) {
        return url.pathname + url.search;
    }
    return null;
}

class BucketPilotAction extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_bucketpilot_action d-flex flex-column flex-grow-1 overflow-hidden">
            <iframe class="w-100 h-100 flex-grow-1 border-0" title="BucketPilot"
                    referrerpolicy="same-origin" t-att-src="source" t-ref="page" t-on-load="onLoad"/>
        </div>
    `;

    setup() {
        this.source = pagePath(router.current.bp_page) || HOME;
        this.frame = useRef("page");
        useExternalListener(window, "message", (event) => {
            const frame = this.frame.el;
            if (frame && event.source === frame.contentWindow && event.origin === window.location.origin
                && event.data === "bucketpilot:address-change") {
                this.updateLocation(frame);
            }
        });
    }

    onLoad(event) {
        this.updateLocation(event.currentTarget);
    }

    updateLocation(frame) {
        const url = frame.contentDocument?.URL;
        if (!url || url === "about:blank") {
            return;
        }
        const current = new URL(url);
        if (current.pathname === "/web/login") {
            const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.assign(`/web/login?redirect=${returnTo}`);
            return;
        }
        const page = pagePath(current.pathname + current.search);
        if (page && (router.current.bp_page || HOME) !== page) {
            // Frame navigation creates the browser entry. Keep its parent URL shareable.
            router.replaceState({ bp_page: page === HOME ? undefined : page }, { sync: true });
        }
    }
}

registry.category("actions").add("bucketpilot.app", BucketPilotAction);
