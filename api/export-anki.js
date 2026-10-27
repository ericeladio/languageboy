import { Buffer } from "node:buffer";
import { ZipArchive } from "archiver";

const SOUNDS_API = "https://api.soundoftext.com/sounds";
const MAX_CARDS = 100;
const MAX_TEXT_LENGTH = 500;
const MAX_EXAMPLE_LENGTH = 4000;
const TTS_TIMEOUT_MS = 45000;
const EXPORT_BUDGET_MS = 240000;
const POLL_INTERVAL_MS = 750;
const CONCURRENCY = 4;
const LANGUAGES = {
    en: { name: "English", voice: "en-US" },
    es: { name: "Spanish", voice: "es-ES" },
    ja: { name: "Japanese", voice: "ja-JP" },
    it: { name: "Italian", voice: "it-IT" }
};

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Audio-Total, X-Audio-Failures");
}

function sendJson(res, status, payload) {
    if (res.headersSent || res.writableEnded) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(req) {
    if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === "string") return JSON.parse(req.body);
        return req.body;
    }

    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return null;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeLanguage(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || !LANGUAGES[value]) return null;
    return value;
}

function normalizeRequest(body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.cards)) return null;
    if (body.cards.length < 1 || body.cards.length > MAX_CARDS) return null;

    const fromLang = normalizeLanguage(body.fromLang, "en");
    const toLang = normalizeLanguage(body.toLang, "es");
    if (!fromLang || !toLang) return null;
    if (body.voice !== undefined && body.voice !== LANGUAGES[fromLang].voice) return null;
    if (body.collectionName !== undefined && typeof body.collectionName !== "string") return null;
    const collectionName = typeof body.collectionName === "string" ? body.collectionName.trim().slice(0, 80) : "";

    const cards = [];
    for (const card of body.cards) {
        if (!card || typeof card !== "object") return null;

        const en = typeof card.en === "string" ? card.en.trim() : "";
        const es = typeof card.es === "string" ? card.es.trim() : "";
        const example = typeof card.example === "string" ? card.example.trim() : "";
        const exampleTranslation = typeof card.exampleTranslation === "string" ? card.exampleTranslation.trim() : "";

        if (!en || !es) return null;
        if (en.length > MAX_TEXT_LENGTH || es.length > MAX_TEXT_LENGTH) return null;
        if (example.length > MAX_EXAMPLE_LENGTH || exampleTranslation.length > MAX_EXAMPLE_LENGTH) return null;

        cards.push({ en, es, example, exampleTranslation });
    }

    return { cards, fromLang, toLang, collectionName };
}

async function createSound(text, voice, deadline) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() >= deadline) throw new Error("Export time limit reached");
        try {
            const response = await fetch(SOUNDS_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    engine: "Google",
                    data: { text, voice }
                })
            });

            if (response.status === 429 || response.status >= 500) {
                lastError = new Error(`Sound of Text create failed with HTTP ${response.status}`);
                await sleep(1000 * (attempt + 1));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Sound of Text create failed with HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data || data.success === false || !data.id) {
                throw new Error(data && data.message ? data.message : "Sound of Text did not return an id");
            }
            return data.id;
        } catch (error) {
            lastError = error;
            if (attempt < 2) await sleep(1000 * (attempt + 1));
        }
    }

    throw lastError || new Error("Sound of Text create failed");
}

async function waitForSound(id, deadline) {
    const timeoutAt = Math.min(deadline, Date.now() + TTS_TIMEOUT_MS);
    let lastError;

    while (Date.now() < timeoutAt) {
        try {
            const response = await fetch(`${SOUNDS_API}/${encodeURIComponent(id)}`);
            if (response.status === 429 || response.status >= 500) {
                lastError = new Error(`Sound of Text status failed with HTTP ${response.status}`);
                await sleep(POLL_INTERVAL_MS * 2);
                continue;
            }

            if (!response.ok) {
                throw new Error(`Sound of Text status failed with HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data && data.status === "Done" && data.location) {
                return data.location;
            }
            if (data && data.status === "Error") {
                throw new Error(data.message || "Sound of Text could not generate audio");
            }
        } catch (error) {
            lastError = error;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    throw lastError || new Error("Sound of Text timed out");
}

async function downloadAudio(location) {
    let url;

    try {
        url = new URL(location);
    } catch {
        throw new Error("Sound of Text returned an invalid audio URL");
    }

    if (url.protocol !== "https:" || (url.hostname !== "soundoftext.com" && !url.hostname.endsWith(".soundoftext.com"))) {
        throw new Error("Sound of Text returned an untrusted audio URL");
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`Audio download failed with HTTP ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType && contentType.startsWith("text/")) {
        throw new Error("Audio download returned a text response");
    }
    if (contentType.includes("json") || contentType.includes("html")) {
        throw new Error("Audio download returned an HTML response");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error("Audio download returned an empty file");
    }
    return buffer;
}

async function generateAudio(text, voice, deadline) {
    const id = await createSound(text, voice, deadline);
    const location = await waitForSound(id, deadline);
    return downloadAudio(location);
}

function sanitizeAudioName(text, index) {
    const base = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60) || "word";

    return `${String(index).padStart(3, "0")}_${base}.mp3`;
}

function sanitizeZipName(text) {
    return String(text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60);
}

function buildCsv(rows, fromLang, toLang) {
    const lines = [[LANGUAGES[fromLang].name, LANGUAGES[toLang].name, "Example", "Example Translation", "Audio"]];
    for (const row of rows) lines.push(row);
    return lines
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function run() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
    await Promise.all(runners);
    return results;
}

export default async function handler(req, res) {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        sendJson(res, 405, { error: "Method not allowed" });
        return;
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch {
        sendJson(res, 400, { error: "Request body must be valid JSON" });
        return;
    }

    const request = normalizeRequest(body);
    if (!request) {
        sendJson(res, 400, {
            error: `Provide 1 to ${MAX_CARDS} cards with "en" and "es" strings, optional "example"/"exampleTranslation" strings, optional "collectionName", and optional "fromLang"/"toLang" codes (en, es, ja, it)`
        });
        return;
    }

    const { cards, fromLang, toLang, collectionName } = request;
    const voice = LANGUAGES[fromLang].voice;
    const uniqueTexts = [];
    const seenTexts = new Set();
    for (const card of cards) {
        if (!seenTexts.has(card.en)) {
            seenTexts.add(card.en);
            uniqueTexts.push(card.en);
        }
    }

    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;
    const audioResults = await mapWithConcurrency(uniqueTexts, CONCURRENCY, async (text, index) => {
        if (Date.now() >= exportDeadline) {
            return { text, error: "Export time limit reached" };
        }
        try {
            const buffer = await generateAudio(text, voice, exportDeadline);
            return { text, buffer, name: sanitizeAudioName(text, index + 1) };
        } catch (error) {
            return {
                text,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });

    const audioByText = new Map(audioResults.map((result) => [result.text, result]));
    const csvRows = cards.map((card) => {
        const audio = audioByText.get(card.en);
        return [
            card.en,
            card.es,
            card.example || card.en,
            card.exampleTranslation || "",
            audio && audio.name ? `[sound:${audio.name}]` : ""
        ];
    });

    const failures = audioResults.filter((result) => result.error);
    const date = new Date().toISOString().slice(0, 10);
    const collectionPart = sanitizeZipName(collectionName);
    const filename = collectionPart ? `languageboy_${collectionPart}_${date}.zip` : `languageboy_anki_${date}.zip`;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Audio-Total", String(uniqueTexts.length));
    res.setHeader("X-Audio-Failures", String(failures.length));

    const archive = new ZipArchive({ zlib: { level: 9 } });
    let finished = false;

    archive.on("warning", (error) => {
        if (error.code !== "ENOENT") {
            finished = true;
            if (!res.headersSent) {
                sendJson(res, 502, { error: "Could not build the ZIP file" });
            } else {
                res.destroy(error);
            }
        }
    });

    archive.on("error", (error) => {
        finished = true;
        if (!res.headersSent) {
            sendJson(res, 502, { error: "Could not build the ZIP file" });
        } else {
            res.destroy(error);
        }
    });

    archive.pipe(res);
    archive.append(`\uFEFF${buildCsv(csvRows, fromLang, toLang)}`, { name: "anki_cards.csv" });

    for (const result of audioResults) {
        if (result.buffer) {
            archive.append(result.buffer, { name: result.name, store: true });
        }
    }

    if (failures.length > 0) {
        const failureText = failures
            .map((result) => `${result.text}\t${result.error}`)
            .join("\r\n");
        archive.append(`${failureText}\r\n`, { name: "failed.txt" });
    }

    try {
        await archive.finalize();
    } catch (error) {
        if (!finished) {
            finished = true;
            if (!res.headersSent) {
                sendJson(res, 502, { error: "Could not build the ZIP file" });
            } else {
                res.destroy(error);
            }
        }
    }
}
