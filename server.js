import 'dotenv/config';
import express from 'express';
import sharp from 'sharp';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ticktickFetch } from './ticktick-auth.js';
import e from 'express';

const app = express();
const port = 3000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectId = process.env.EPAPER_PROJECT_ID;

const fontBuffer = await readFile('./fonts/cambria.ttf');
const fontBase64 = fontBuffer.toString('base64');

app.get('/display.jpg', async (req, res) => {
    try {
        let battery = req.query.battery ? parseInt(req.query.battery) : null;

        if (battery !== null) {
            if (battery < 0)
                battery = 0;
            else if (battery > 100)
                battery = 100;
        }

        const now = new Date();
        const hour = now.getHours();
        const day = now.getDay(); // 0 is Sunday, 6 is Saturday

        // 1. Determine Mode
        const isWeekend = (day === 0 || day === 6);
        const isAfterWork = (hour >= 17 || hour < 8);
        
        let finalBuffer;

        if (isWeekend || isAfterWork) {
            console.log("Mode: ART");
            finalBuffer = await generateArtBuffer();
        } else {
            console.log("Mode: TODO");
            finalBuffer = await generateTodoBuffer(battery);
        }

        // 2. Send the image
        res.type('image/jpeg').send(finalBuffer);
        
    } catch (err) {
        console.error(err);
        res.status(500).send("Error rendering display");
    }
});

// Helper: Process Art
async function generateArtBuffer() {
    const ART_FOLDER = path.join(__dirname, 'assets'); // This is your Docker mount point
    
    try {
        const randomImagePath = await getRandomArtPath(ART_FOLDER);
        console.log(`Rendering: ${randomImagePath}`);

        return await sharp(randomImagePath)
            .resize(960, 540, { 
                fit: 'cover',
                position: 'center' 
            })
            .grayscale()
            .gamma(1.5)
            .toFormat('jpeg')
            .toBuffer();
    } catch (err) {
        console.error("Art selection failed:", err.message);
        // Return a fallback (like a simple black square) if folder is empty
        return await sharp({
            create: { width: 960, height: 540, channels: 1, background: { r: 0, g: 0, b: 0 } }
        }).toFormat('jpeg').toBuffer();
    }
}

async function getRandomArtPath(folderPath) {
    const files = await readdir(folderPath);
    
    // Filter for images only (jpg, jpeg, png)
    const images = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.jpg', '.jpeg', '.png'].includes(ext);
    });

    if (images.length === 0) {
        throw new Error(`No images found in ${folderPath}`);
    }

    // Pick a random index
    const randomIndex = Math.floor(Math.random() * images.length);
    const selectedImage = images[randomIndex];

    return path.join(folderPath, selectedImage);
}

async function generateTodoBuffer(battery) {
    const data = await ticktickFetch(`/open/v1/project/${projectId}/data`);
    const tasks = (data.tasks ?? [])
        .filter(t => t.status === 0)
        .sort((a, b) => {
            const dateA = a.dueDate ? new Date(a.dueDate) : Infinity;
            const dateB = b.dueDate ? new Date(b.dueDate) : Infinity;
            if (dateA !== dateB) return dateA - dateB;         // earliest due date first
            return (b.priority ?? 0) - (a.priority ?? 0);     // then highest priority first
        });

    const PADDING = 60;
    const ROW_HEIGHT = 58;
    const HEADER_HEIGHT = 80;

    const prioritySymbol = (p) => ({ 5: '▲', 3: '◆', 1: '▼', 0: ' ' }[p] ?? ' ');
    const priorityLabel  = (p) => ({ 5: 'HIGH', 3: 'MED', 1: 'LOW', 0: '' }[p] ?? '');

    const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    if (d.toDateString() === today.toDateString())    return 'Today';
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    
    if (d.getFullYear() !== today.getFullYear()) {
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

    const isOverdue = (dateStr) => {
        if (!dateStr) return false;
        return new Date(dateStr) < new Date() && formatDate(dateStr) !== 'Today';
    };

    const now = new Date().toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long'
    });

    const visibleTasks = tasks.slice(0, 6); // max 6 rows fit at this size
    const remaining    = tasks.length - visibleTasks.length;

    const rows = visibleTasks.map((task, i) => {
        const y = HEADER_HEIGHT + i * ROW_HEIGHT;
        const sym = prioritySymbol(task.priority);
        const lbl = priorityLabel(task.priority);
        const due = formatDate(task.dueDate);
        const overdue = isOverdue(task.dueDate);

        // Truncate long titles
        const title = task.title.length > 42 ? task.title.slice(0, 41) + '…' : task.title;

        // Alternating row background
        const rowBg = i % 2 === 0
            ? `<rect x="0" y="${y}" width="960" height="${ROW_HEIGHT}" fill="#f5f5f5"/>`
            : '';

        return `
            ${rowBg}
            <!-- Divider -->
            <line x1="${PADDING}" y1="${y}" x2="${960 - PADDING}" y2="${y}" stroke="#ddd" stroke-width="1"/>
            <!-- Priority symbol -->
            <text x="${PADDING}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="18" fill="${task.priority === 5 ? '#000' : '#888'}" font-weight="${task.priority === 5 ? 'bold' : 'normal'}">${sym}</text>
            <!-- Priority label -->
            <text x="${PADDING + 30}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="16" fill="#888" font-weight="bold">${lbl}</text>
            <!-- Task title -->
            <text x="${PADDING + 90}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="24" fill="#111">${title}</text>
            <!-- Due date -->
            <text x="${960 - PADDING}" y="${y + ROW_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="16" fill="${overdue ? '#000' : '#666'}" font-weight="${overdue ? 'bold' : 'normal'}" text-anchor="end">${overdue ? '⚠ ' : ''}${due}</text>
        `;
    }).join('');

    const BAR_Y = 504;
    const BAR_HEIGHT = 36;
    const BAR_MID = BAR_Y + BAR_HEIGHT / 2;
    const ICON_H = 20;
    const ICON_W = 40;

    const batteryIndicator = battery !== null ? `
        <!-- Black footer bar -->
        <rect x="0" y="${BAR_Y}" width="960" height="${BAR_HEIGHT}" fill="#111"/>
        <!-- Battery icon outline -->
        <rect x="${PADDING}" y="${BAR_MID - ICON_H / 2}" width="${ICON_W}" height="${ICON_H}" rx="2" stroke="#aaa" stroke-width="1.5" fill="none"/>
        <rect x="${PADDING + ICON_W}" y="${BAR_MID - 4}" width="3" height="8" rx="1" fill="#aaa"/>
        <!-- Battery fill -->
        <rect x="${PADDING + 2}" y="${BAR_MID - ICON_H / 2 + 2}" width="${Math.round((ICON_W - 4) * battery / 100)}" height="${ICON_H - 4}" rx="1" fill="${battery <= 20 ? '#fff' : '#aaa'}"/>
        <!-- Battery percentage text -->
        <text x="${PADDING + ICON_W + 12}" y="${BAR_MID}" dominant-baseline="middle" font-family="Cambria" font-size="18" fill="#aaa">${battery}%</text>
    ` : '';

    const footer = remaining > 0
        ? `<text x="${960 - PADDING}" y="508" font-family="Cambria" font-size="22" fill="#888" text-anchor="end">+ ${remaining} more tasks</text>`
        : '';

    const svgText = `
        <svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <style>
                    @font-face {
                        font-family: 'Cambria';
                        src: url('data:font/truetype;base64,${fontBase64}');
                    }
                </style>
            </defs>

            <rect width="100%" height="100%" fill="white"/>

            <!-- Header bar -->
            <rect x="0" y="0" width="960" height="${HEADER_HEIGHT}" fill="#111"/>
            <text x="${PADDING}" y="${HEADER_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="32" font-weight="bold" fill="white">Tasks</text>
            <text x="${960 - PADDING}" y="${HEADER_HEIGHT / 2}" dominant-baseline="middle" font-family="Cambria" font-size="22" fill="#aaa" text-anchor="end">${now}</text>

            ${rows}
            ${footer}
            ${batteryIndicator}
        </svg>`;

    return await sharp(Buffer.from(svgText))
        .toFormat('jpeg')
        .toBuffer();
}

app.listen(port, '0.0.0.0', () => {
    console.log(`E-ink Server active on port ${port}`);
});