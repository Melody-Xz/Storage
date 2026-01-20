"use strict";

import axios from "axios";
import crypto from "crypto";
import { promises as fs, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import ytSearch from 'yt-search';

const LIB_DIR = path.join(process.cwd(), 'lib');
const CACHE_FILE = path.join(LIB_DIR, 'ytcache.json');
const TTL = 8 * 24 * 60 * 60 * 1000;

const fastCache = new Map();
const searchCache = new Map();

(function initFastCache() {
    try {
        if (!existsSync(LIB_DIR)) mkdirSync(LIB_DIR, { recursive: true });
        
        if (existsSync(CACHE_FILE)) {
            const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
            Object.entries(data).forEach(([k, v]) => {
                if (Date.now() - v.ts < TTL) fastCache.set(k, v);
            });
        } else {
            fs.writeFile(CACHE_FILE, JSON.stringify({})).catch(() => null);
        }
    } catch (e) { }
})();

async function syncToDisk() {
    try {
        const data = Object.fromEntries(fastCache);
        await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch {}
}

async function isUrlValidAndFull(url) {
    try {
        const res = await axios.head(url, { timeout: 2500 });
        const size = parseInt(res.headers['content-length'] || '0');
        return res.status === 200 && size > 102400;
    } catch { return false; }
}

async function fastSearch(query) {
    const q = query.toLowerCase().trim();
    if (searchCache.has(q)) return searchCache.get(q);
    const res = await ytSearch({ query: q, hl: 'es', gl: 'ES' });
    const video = res.videos[0];
    if (video) searchCache.set(q, video);
    return video;
}

const motorYTDown = {
    download: async (url, type) => {
        try {
            const { data: info } = await axios.post('https://ytdown.to/proxy.php', `url=${encodeURIComponent(url)}`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 20000 
            });
            const items = info.api.mediaItems;
            let item = type === 'audio' 
                ? items.find(it => it.type === 'Audio') 
                : (items.find(it => it.type === 'Video' && it.mediaRes === '360') || items.find(it => it.type === 'Video'));

            for (let i = 0; i < 10; i++) {
                const { data: res } = await axios.post('https://ytdown.to/proxy.php', `url=${encodeURIComponent(item.mediaUrl)}`, { timeout: 15000 });
                if (res.api?.fileUrl && await isUrlValidAndFull(res.api.fileUrl)) {
                    return { download: res.api.fileUrl, title: item.name, winner: `YTDown ${type}` };
                }
                await new Promise(r => setTimeout(r, 1500));
            }
            throw new Error();
        } catch { throw new Error(); }
    }
};

const motorSavetube = {
    download: async (url, type) => {
        try {
            const id = url.match(/[?&]v=([^&#]+)|youtu\.be\/([^&#]+)|shorts\/([^&#]+)/)?.[1] || url.split('/').pop();
            const { data: info } = await axios.post(`https://media.savetube.me/api/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { timeout: 10000 });
            const key = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');
            const enc = info.data.data || info.data;
            const b = Buffer.from(enc, 'base64'), iv = b.slice(0, 16), content = b.slice(16);
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            const dec = JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString());
            const { data: dl } = await axios.post(`https://media.savetube.me/api/download`, { id, downloadType: type, quality: type === 'audio' ? '128' : '360', key: dec.key }, { timeout: 15000 });
            const link = dl.data?.downloadUrl || dl.downloadUrl;
            if (link && await isUrlValidAndFull(link)) {
                return { download: link, title: dec.title, winner: `Savetube ${type}` };
            }
            throw new Error();
        } catch { throw new Error(); }
    }
};

const motorEzconv = {
    download: async (url) => {
        try {
            const cf = await axios.get(`https://anabot.my.id/api/tools/bypass?url=https://ezconv.cc&siteKey=0x4AAAAAAAi2NuZzwS99-7op&type=turnstile-min&apikey=freeApikey`, { timeout: 10000 });
            const { data } = await axios.post('https://ds1.ezsrv.net/api/convert', { url, quality: '320', captchaToken: cf.data.data.result.token }, { timeout: 15000 });
            if (data.status === 'done' && await isUrlValidAndFull(data.url)) {
                return { download: data.url, title: data.title, winner: 'Ezconv Audio' };
            }
            throw new Error();
        } catch { throw new Error(); }
    }
};

async function raceWithFallback(url, isAudio) {
    const key = crypto.createHash('md5').update(`${url}_${isAudio}`).digest('hex');
    const entry = fastCache.get(key);
    
    if (entry && (Date.now() - entry.ts < TTL)) {
        if (await isUrlValidAndFull(entry.res.download)) {
            console.log(colorize(`[RAM] Entrega instantánea`));
            return entry.res;
        } else {
            fastCache.delete(key);
            syncToDisk();
        }
    }

    const type = isAudio ? 'audio' : 'video';
    const race = isAudio 
        ? [ motorYTDown.download(url, 'audio'), motorEzconv.download(url), motorSavetube.download(url, 'audio') ] 
        : [ motorYTDown.download(url, 'video'), motorSavetube.download(url, 'video') ];

    try {
        const result = await Promise.any(race);
        console.log(colorize(`[NUEVO] Winner: ${result.winner}`));
        fastCache.set(key, { res: result, ts: Date.now() });
        syncToDisk(); 
        return result;
    } catch {
        console.log(colorize(`[ERROR] Fallo en motores`, true));
        return null;
    }
}

function cleanFileName(n) {
    return n.replace(/[<>:"/\\|?*]/g, "").substring(0, 50);
}

async function getBufferFromUrl(url) {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
        return Buffer.from(res.data);
    } catch { return Buffer.alloc(0); }
}

function colorize(text, isError = false) {
    const codes = { cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m' };
    const prefix = isError ? 'ꕤ [ERROR]' : '✰ [ENVIADO]';
    return `${isError ? codes.red : codes.cyan}${codes.bold}${prefix}${codes.reset} ${text.split(']')[1] || text}`;
}

export { raceWithFallback, fastSearch, cleanFileName, getBufferFromUrl, colorize };
