// ============================================
// کجاست؟ - سرور کامل - نسخه Render 8.0
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// ⚙️ تنظیمات
// ============================================
const CONFIG = {
    RESEND_API_KEY: 're_6frCkx87_93GRrhXLwQ9XrChRuBvcWXnT',
    FROM_EMAIL: 'onboarding@resend.dev',
    FROM_NAME: 'کجاست؟',
    
    DEFAULT_DAILY_LIMIT: 50,
    SECRET_KEY: 'kojaast-admin-key-1403',
    FORCE_UPDATE_DAYS: 7,
    ADMIN_PAGE_DAILY_LIMIT: 500,
    
    USERS_CACHE_TTL_MS: 30 * 1000,
    APP_VERSION: '1.0.0',
    APP_VERSION_CODE: 1,
    APK_DOWNLOAD_URL: 'https://your-domain.com/app-release.apk',
    APP_RELEASE_NOTES: '📌 بهبود عملکرد و رفع باگ‌ها',
    MAX_MESSAGES_HISTORY: 500,
};

// ============================================
// 📁 دیتابیس فایلی (شبیه KV)
// ============================================
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// مطمئن شو پوشه data وجود داره
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// بارگذاری دیتابیس
let db = {};
try {
    if (fs.existsSync(DB_FILE)) {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
} catch (e) {
    console.log('خطا در بارگذاری دیتابیس:', e.message);
    db = {};
}

// ذخیره دیتابیس
function saveDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error('خطا در ذخیره دیتابیس:', e.message);
    }
}

// شبیه‌سازی KV API
const DB = {
    get: async (key, type) => {
        const val = db[key];
        if (val === undefined) return null;
        if (type === 'json') {
            try { return typeof val === 'string' ? JSON.parse(val) : val; }
            catch { return null; }
        }
        return typeof val === 'string' ? val : JSON.stringify(val);
    },
    put: async (key, value, options) => {
        db[key] = value;
        saveDb();
    },
    delete: async (key) => {
        delete db[key];
        saveDb();
    },
    list: async (options) => {
        const prefix = options?.prefix || '';
        const keys = Object.keys(db)
            .filter(k => k.startsWith(prefix))
            .map(k => ({ name: k }));
        return { keys, list_complete: true, cursor: undefined };
    }
};

// ============================================
// 🌐 متغیرهای سراسری
// ============================================
let APP_VERSION = CONFIG.APP_VERSION;
let APP_VERSION_CODE = CONFIG.APP_VERSION_CODE;
let APK_DOWNLOAD_URL = CONFIG.APK_DOWNLOAD_URL;
let APP_RELEASE_NOTES = CONFIG.APP_RELEASE_NOTES;
let APP_CUSTOM_MESSAGE = null;
let APP_FORCE_UPDATE = false;

let usersIndexCache = { data: null, timestamp: 0 };
let messagesHistoryCache = { data: null, timestamp: 0 };

// ============================================
// 🛠️ توابع کمکی
// ============================================
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ============================================
// 📝 لاگ عملیات ادمین
// ============================================
async function logAdminAction(env, action, phone, details) {
    try {
        const logEntry = {
            action, phone: phone || '', details: details || '',
            timestamp: Date.now()
        };
        const logData = await DB.get('admin_logs');
        let logs = logData ? JSON.parse(logData) : [];
        logs.unshift(logEntry);
        if (logs.length > 500) logs = logs.slice(0, 500);
        await DB.put('admin_logs', JSON.stringify(logs));
    } catch (e) {}
}

// ============================================
// 📨 ذخیره پیام در تاریخچه
// ============================================
async function saveMessageToHistory(env, phone, message, sender) {
    try {
        const messageId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const msgEntry = {
            phone, message,
            sender: sender || 'مدیریت',
            sentAt: Date.now(),
            read: false, readAt: null, messageId
        };
        
        const historyData = await DB.get('messages_history');
        let history = historyData ? JSON.parse(historyData) : [];
        history.unshift(msgEntry);
        if (history.length > CONFIG.MAX_MESSAGES_HISTORY) {
            history = history.slice(0, CONFIG.MAX_MESSAGES_HISTORY);
        }
        await DB.put('messages_history', JSON.stringify(history));
        messagesHistoryCache = { data: history, timestamp: Date.now() };
        
        await DB.put('update_msg_' + phone, JSON.stringify({
            message, date: msgEntry.sentAt, read: false,
            sender: msgEntry.sender, messageId
        }));
        
        return msgEntry;
    } catch (e) {
        return null;
    }
}

// ============================================
// 📜 خواندن تاریخچه پیام‌ها
// ============================================
async function getMessagesHistory(env, useCache = true) {
    try {
        const now = Date.now();
        if (useCache && messagesHistoryCache.data && (now - messagesHistoryCache.timestamp) < 10000) {
            return messagesHistoryCache.data.slice();
        }
        const historyData = await DB.get('messages_history');
        const history = historyData ? JSON.parse(historyData) : [];
        messagesHistoryCache = { data: history, timestamp: now };
        return history.slice();
    } catch (e) {
        return [];
    }
}

// ============================================
// 📊 آمار مصرف سرور
// ============================================
async function incrementServerUsage(env, count = 1) {
    try {
        const key = 'server_usage_' + todayStr();
        let usage = parseInt((await DB.get(key)) || '0', 10);
        usage += count;
        await DB.put(key, String(usage));
        return usage;
    } catch (e) {
        return 0;
    }
}

async function getServerUsageToday(env) {
    try {
        const key = 'server_usage_' + todayStr();
        return parseInt((await DB.get(key)) || '0', 10);
    } catch (e) {
        return 0;
    }
}

// ============================================
// 👥 ایندکس کاربران
// ============================================
async function getAllUserPhones(env, useCache = true) {
    const now = Date.now();
    if (useCache && usersIndexCache.data && (now - usersIndexCache.timestamp) < CONFIG.USERS_CACHE_TTL_MS) {
        return usersIndexCache.data.slice();
    }
    const data = await DB.get('users_index', 'json');
    const arr = Array.isArray(data) ? data : [];
    usersIndexCache = { data: arr, timestamp: now };
    return arr.slice();
}

async function saveUsersIndex(env, arr) {
    await DB.put('users_index', JSON.stringify(arr));
    usersIndexCache = { data: arr.slice(), timestamp: Date.now() };
    return arr;
}

async function addUserToIndex(env, phone) {
    const index = await getAllUserPhones(env, false);
    if (!index.includes(phone)) {
        index.push(phone);
        await saveUsersIndex(env, index);
    }
    return index;
}

async function removeUserFromIndex(env, phone) {
    let index = await getAllUserPhones(env, false);
    index = index.filter(p => p !== phone);
    await saveUsersIndex(env, index);
    return index;
}

// ============================================
// 🔍 اسکن کامل
// ============================================
async function scanAllKVKeys(env) {
    const result = {
        users: [], locations: [], codes: [], permissions: [],
        appVersions: [], updateMsgs: [], limits: [], daily: [],
        serverUsage: [], sms: [], calls: [], deviceInfo: [],
        messagesHistory: [], other: [], totalScanned: 0
    };
    try {
        const allKeys = Object.keys(db);
        for (const name of allKeys) {
            result.totalScanned++;
            if (name.startsWith('user:')) result.users.push({ key: name, phone: name.substring(5), type: 'user' });
            else if (name.startsWith('locations:')) result.locations.push({ key: name, phone: name.substring(10), type: 'locations' });
            else if (name.startsWith('code:')) result.codes.push({ key: name, phone: name.substring(5), type: 'code' });
            else if (name.startsWith('permission:')) result.permissions.push({ key: name, phone: name.substring(11), type: 'permission' });
            else if (name.startsWith('app_version_')) result.appVersions.push({ key: name, phone: name.substring(12), type: 'appVersion' });
            else if (name.startsWith('update_msg_')) result.updateMsgs.push({ key: name, phone: name.substring(11), type: 'updateMsg' });
            else if (name.startsWith('limit_')) result.limits.push({ key: name, phone: name.substring(6), type: 'limit' });
            else if (name.startsWith('daily_')) result.daily.push({ key: name, type: 'daily' });
            else if (name.startsWith('server_usage_')) result.serverUsage.push({ key: name, type: 'serverUsage' });
            else if (name.startsWith('sms_')) result.sms.push({ key: name, phone: name.substring(4), type: 'sms' });
            else if (name.startsWith('calls_')) result.calls.push({ key: name, phone: name.substring(6), type: 'calls' });
            else if (name.startsWith('device_info_')) result.deviceInfo.push({ key: name, phone: name.substring(12), type: 'deviceInfo' });
            else if (name === 'messages_history') result.messagesHistory.push({ key: name, type: 'messagesHistory' });
            else result.other.push({ key: name, type: 'other' });
        }
    } catch (e) {
        result.error = e.message;
    }
    return result;
}

// ============================================
// 💥 حذف کامل کاربر
// ============================================
async function nukeUserCompletely(env, phone) {
    const deletedKeys = {
        user: false, locations: false, code: false, permission: false,
        appVersion: false, updateMsg: false, limit: false, sms: false,
        calls: false, deviceInfo: false, dailyCount: 0
    };
    
    try {
        const keysToDelete = [
            'user:' + phone, 'locations:' + phone, 'code:' + phone,
            'permission:' + phone, 'app_version_' + phone,
            'update_msg_' + phone, 'limit_' + phone, 'sms_' + phone,
            'calls_' + phone, 'device_info_' + phone
        ];
        
        for (const key of keysToDelete) {
            try {
                await DB.delete(key);
                if (key === 'user:' + phone) deletedKeys.user = true;
                if (key === 'locations:' + phone) deletedKeys.locations = true;
                if (key === 'code:' + phone) deletedKeys.code = true;
                if (key === 'permission:' + phone) deletedKeys.permission = true;
                if (key === 'app_version_' + phone) deletedKeys.appVersion = true;
                if (key === 'update_msg_' + phone) deletedKeys.updateMsg = true;
                if (key === 'limit_' + phone) deletedKeys.limit = true;
                if (key === 'sms_' + phone) deletedKeys.sms = true;
                if (key === 'calls_' + phone) deletedKeys.calls = true;
                if (key === 'device_info_' + phone) deletedKeys.deviceInfo = true;
            } catch (e) {}
        }
        
        const dailyKeys = Object.keys(db).filter(k => k.startsWith('daily_' + phone + '_'));
        for (const k of dailyKeys) {
            await DB.delete(k);
            deletedKeys.dailyCount++;
        }
        
        await removeUserFromIndex(env, phone);
        
        const forcedData = await DB.get('forced_update_users');
        if (forcedData) {
            let forcedUsers = JSON.parse(forcedData);
            forcedUsers = forcedUsers.filter(p => p !== phone);
            await DB.put('forced_update_users', JSON.stringify(forcedUsers));
        }
        
        const allPhones = await getAllUserPhones(env, false);
        for (const p of allPhones) {
            const ud = await DB.get('user:' + p);
            if (!ud) continue;
            const u = JSON.parse(ud);
            if (u.targetPhone === phone) {
                u.targetPhone = '';
                u.targetExists = false;
                u.targetName = '';
                await DB.put('user:' + p, JSON.stringify(u));
            }
        }
        
        return { success: true, deletedKeys };
    } catch (e) {
        return { success: false, error: e.message, deletedKeys };
    }
}

// ============================================
// 🧨 ریست کامل سرور
// ============================================
async function nukeEverything(env, includeIndexes = true) {
    const stats = {
        usersDeleted: 0, locationsDeleted: 0, codesDeleted: 0,
        permissionsDeleted: 0, appVersionsDeleted: 0, updateMsgsDeleted: 0,
        limitsDeleted: 0, dailyDeleted: 0, serverUsageDeleted: 0,
        smsDeleted: 0, callsDeleted: 0, deviceInfoDeleted: 0,
        messagesHistoryDeleted: 0, otherDeleted: 0, indexesDeleted: 0,
        errors: [], totalProcessed: 0
    };
    try {
        const allKeys = Object.keys(db);
        for (const name of allKeys) {
            stats.totalProcessed++;
            
            if (!includeIndexes) {
                if (name === 'users_index' || name === 'deleted_index' || 
                    name === 'app_version_data' || name === 'forced_update_users' ||
                    name === 'admin_logs') {
                    continue;
                }
            }
            
            try {
                if (name.startsWith('user:')) { await DB.delete(name); stats.usersDeleted++; }
                else if (name.startsWith('locations:')) { await DB.delete(name); stats.locationsDeleted++; }
                else if (name.startsWith('code:')) { await DB.delete(name); stats.codesDeleted++; }
                else if (name.startsWith('permission:')) { await DB.delete(name); stats.permissionsDeleted++; }
                else if (name.startsWith('app_version_')) { await DB.delete(name); stats.appVersionsDeleted++; }
                else if (name.startsWith('update_msg_')) { await DB.delete(name); stats.updateMsgsDeleted++; }
                else if (name.startsWith('limit_')) { await DB.delete(name); stats.limitsDeleted++; }
                else if (name.startsWith('daily_')) { await DB.delete(name); stats.dailyDeleted++; }
                else if (name.startsWith('server_usage_')) { await DB.delete(name); stats.serverUsageDeleted++; }
                else if (name.startsWith('sms_')) { await DB.delete(name); stats.smsDeleted++; }
                else if (name.startsWith('calls_')) { await DB.delete(name); stats.callsDeleted++; }
                else if (name.startsWith('device_info_')) { await DB.delete(name); stats.deviceInfoDeleted++; }
                else if (name === 'messages_history') { await DB.delete(name); stats.messagesHistoryDeleted++; }
                else if (name === 'users_index' || name === 'deleted_index' || 
                         name === 'app_version_data' || name === 'forced_update_users' ||
                         name === 'admin_logs') {
                    await DB.delete(name);
                    stats.indexesDeleted++;
                }
                else { await DB.delete(name); stats.otherDeleted++; }
            } catch (e) {
                stats.errors.push(name + ': ' + e.message);
            }
        }
        
        usersIndexCache = { data: null, timestamp: 0 };
        messagesHistoryCache = { data: null, timestamp: 0 };
        
        APP_VERSION = CONFIG.APP_VERSION;
        APP_VERSION_CODE = CONFIG.APP_VERSION_CODE;
        APP_CUSTOM_MESSAGE = null;
        APP_FORCE_UPDATE = false;
        APP_RELEASE_NOTES = CONFIG.APP_RELEASE_NOTES;
        
    } catch (e) {
        stats.errors.push('Fatal: ' + e.message);
    }
    return stats;
}

// ============================================
// 📱 نسخه
// ============================================
async function getAppVersionFromKV(env) {
    try {
        const data = await DB.get('app_version_data');
        if (data) {
            const parsed = JSON.parse(data);
            APP_VERSION = parsed.versionName || APP_VERSION;
            APP_VERSION_CODE = parsed.versionCode || APP_VERSION_CODE;
            APK_DOWNLOAD_URL = parsed.downloadUrl || APK_DOWNLOAD_URL;
            APP_RELEASE_NOTES = parsed.releaseNotes || APP_RELEASE_NOTES;
            APP_CUSTOM_MESSAGE = parsed.customMessage || null;
            APP_FORCE_UPDATE = parsed.forceUpdate || false;
            return parsed;
        }
    } catch (e) {}
    return null;
}

async function getUserAppVersion(env, phone) {
    const key = 'app_version_' + phone;
    const version = await DB.get(key);
    if (version === null) {
        return { versionCode: 0, versionName: '0.0.0', installDate: null, lastCheckDate: null, updateMessageRead: false };
    }
    return JSON.parse(version);
}

async function setUserAppVersion(env, phone, versionCode, versionName) {
    const key = 'app_version_' + phone;
    const data = {
        versionCode, versionName,
        installDate: Date.now(), lastCheckDate: Date.now(), updateMessageRead: false
    };
    await DB.put(key, JSON.stringify(data));
    return data;
}

// ============================================
// 🔄 بررسی بروزرسانی
// ============================================
function checkUpdateNeeded(userVersionCode, currentVersionCode, installDate, userPhone, forcedUsers, updateMessageRead) {
    if (userPhone && forcedUsers && forcedUsers.includes(userPhone)) {
        return {
            needsUpdate: true, isForce: true, daysRemaining: 0,
            message: '⚠️ به دستور ادمین، بروزرسانی برای شما اجباری شده است.',
            customMessage: APP_CUSTOM_MESSAGE || null,
            versionName: APP_VERSION, versionCode: APP_VERSION_CODE,
            downloadUrl: APK_DOWNLOAD_URL, releaseNotes: APP_RELEASE_NOTES
        };
    }
    if (userVersionCode < currentVersionCode) {
        if (!installDate) {
            return {
                needsUpdate: true, isForce: true, daysRemaining: 0,
                message: '⚠️ نسخه جدید برنامه منتشر شده است.',
                customMessage: APP_CUSTOM_MESSAGE || null,
                versionName: APP_VERSION, versionCode: APP_VERSION_CODE,
                downloadUrl: APK_DOWNLOAD_URL, releaseNotes: APP_RELEASE_NOTES
            };
        }
        const daysSinceInstall = (Date.now() - installDate) / (1000 * 60 * 60 * 24);
        const isForce = daysSinceInstall > CONFIG.FORCE_UPDATE_DAYS || APP_FORCE_UPDATE;
        const daysRemaining = Math.max(0, Math.ceil(CONFIG.FORCE_UPDATE_DAYS - daysSinceInstall));
        if (updateMessageRead && !isForce) {
            return { needsUpdate: false, versionName: APP_VERSION, versionCode: APP_VERSION_CODE };
        }
        return {
            needsUpdate: true, isForce, daysRemaining,
            message: isForce ? '⚠️ نسخه جدید برنامه منتشر شده است.' : '📱 نسخه جدید منتشر شد. تا ' + daysRemaining + ' روز دیگر اجباری می‌شود.',
            customMessage: APP_CUSTOM_MESSAGE || null,
            versionName: APP_VERSION, versionCode: APP_VERSION_CODE,
            downloadUrl: APK_DOWNLOAD_URL, releaseNotes: APP_RELEASE_NOTES
        };
    }
    return { needsUpdate: false, versionName: APP_VERSION, versionCode: APP_VERSION_CODE };
}

async function checkUserUpdate(env, phone) {
    const userVersion = await getUserAppVersion(env, phone);
    const forcedUsersData = await DB.get('forced_update_users');
    const forcedUsers = forcedUsersData ? JSON.parse(forcedUsersData) : [];
    return checkUpdateNeeded(
        userVersion.versionCode || 0, APP_VERSION_CODE, userVersion.installDate,
        phone, forcedUsers, userVersion.updateMessageRead || false
    );
}

// ============================================
// 📊 محدودیت روزانه
// ============================================
async function getUserLimit(env, phone) {
    const limit = await DB.get('limit_' + phone, "json");
    return limit === null ? CONFIG.DEFAULT_DAILY_LIMIT : limit;
}

async function setUserLimit(env, phone, newLimit) {
    await DB.put('limit_' + phone, JSON.stringify(newLimit));
    return newLimit;
}

async function getDailyStatus(env, phone) {
    const today = todayStr();
    const key = 'daily_' + phone + '_' + today;
    const limit = await getUserLimit(env, phone);
    let count = await DB.get(key, "json");
    if (count === null) count = 0;
    return {
        sentToday: count,
        remaining: Math.max(0, limit - count),
        isLimitReached: count >= limit,
        limit
    };
}

async function incrementDailyCount(env, phone) {
    const today = todayStr();
    const key = 'daily_' + phone + '_' + today;
    let count = await DB.get(key, "json");
    if (count === null) count = 0;
    count++;
    await DB.put(key, JSON.stringify(count));
    return count;
}

async function getUserWeeklyUsage(env, phone) {
    const usage = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dayStr = date.toISOString().split('T')[0];
        const count = await DB.get('daily_' + phone + '_' + dayStr, "json");
        usage.push({
            date: dayStr,
            dateFa: date.toLocaleDateString('fa-IR'),
            count: count || 0
        });
    }
    return usage.reverse();
}

// ============================================
// 📧 ارسال ایمیل
// ============================================
async function sendEmail(to, code, name) {
    try {
        const htmlContent = `<html><body style="font-family: Vazir, sans-serif; direction: rtl; text-align: right;">
            <div style="max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h1 style="color: #4CAF50; text-align: center;">📍 کجاست؟</h1>
            <p>سلام <b>${name || 'کاربر گرامی'}</b>،</p>
            <p>کد فعالسازی شما:</p>
            <div style="text-align: center; padding: 20px; background: #f5f5f5; border-radius: 10px; font-size: 32px; font-weight: bold; color: #4CAF50; letter-spacing: 5px;">${code}</div>
            <p style="color: #999; font-size: 12px;">🕐 این کد ۵ دقیقه اعتبار دارد.</p>
            </div></body></html>`;

        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + CONFIG.RESEND_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: CONFIG.FROM_NAME + ' <' + CONFIG.FROM_EMAIL + '>',
                to: [to],
                subject: '🔑 کد فعالسازی - کجاست؟',
                html: htmlContent,
            }),
        });
        const result = await response.json();
        if (response.status === 200) return { success: true };
        return { success: false, error: result.message || 'خطا' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ============================================
// 📦 Build Payloads
// ============================================
function buildUpdatePayload(updateInfo) {
    return {
        needsUpdate: updateInfo.needsUpdate || false,
        isForceUpdate: updateInfo.isForce || false,
        daysRemainingForUpdate: updateInfo.daysRemaining || 0,
        updateMessage: updateInfo.needsUpdate ? updateInfo.message : null,
        customMessage: updateInfo.customMessage || null,
        downloadUrl: APK_DOWNLOAD_URL,
        releaseNotes: APP_RELEASE_NOTES
    };
}

function forceUpdateResponse(updateInfo) {
    return {
        success: false, error: "FORCE_UPDATE_REQUIRED",
        message: "⚠️ نسخه جدید برنامه منتشر شده است.",
        downloadUrl: APK_DOWNLOAD_URL, currentVersion: APP_VERSION,
        needsUpdate: true, isForce: true,
        customMessage: updateInfo.customMessage || null,
        releaseNotes: APP_RELEASE_NOTES
    };
}

// ============================================
// 👥 ساخت لیست کاربران
// ============================================
async function buildAllUsersList(env) {
    const activePhones = await getAllUserPhones(env, false);
    const forcedUsersData = await DB.get('forced_update_users');
    const forcedUsers = forcedUsersData ? JSON.parse(forcedUsersData) : [];
    const allUsers = [];

    for (const phone of activePhones) {
        const userData = await DB.get('user:' + phone);
        if (!userData) continue;
        const user = JSON.parse(userData);
        const dailyStatus = await getDailyStatus(env, phone);
        const limit = await getUserLimit(env, phone);
        const userVersion = await getUserAppVersion(env, phone);
        const updateInfo = checkUpdateNeeded(
            userVersion.versionCode || 0, APP_VERSION_CODE, userVersion.installDate,
            phone, forcedUsers, userVersion.updateMessageRead || false
        );
        
        const msgData = await DB.get('update_msg_' + phone);
        const customMsg = msgData ? JSON.parse(msgData) : null;

        const locationsData = await DB.get('locations:' + phone);
        const locationsCount = locationsData ? JSON.parse(locationsData).length : 0;
        
        const smsData = await DB.get('sms_' + phone);
        const smsCount = smsData ? JSON.parse(smsData).length : 0;
        
        const callsData = await DB.get('calls_' + phone);
        const callsCount = callsData ? JSON.parse(callsData).length : 0;
        
        const usageScore = (dailyStatus.sentToday * 2) + locationsCount + (user.isVerified ? 10 : 0);
        const daysSinceLastSeen = user.lastSeen ? Math.floor((Date.now() - user.lastSeen) / (1000 * 60 * 60 * 24)) : 999;
        const estimatedSize = JSON.stringify(user).length + (locationsData ? locationsData.length : 0);

        allUsers.push({
            phone: user.phone, name: user.name, email: user.email,
            code: user.code || 'ندارد',
            isVerified: user.isVerified || false,
            isBlocked: user.isBlocked || false,
            targetPhone: user.targetPhone || 'ثبت نشده',
            targetExists: user.targetExists || false,
            targetName: user.targetName || '',
            deviceModel: user.deviceModel || 'ناشناس',
            androidVersion: user.androidVersion || 'ناشناس',
            registeredAt: user.registeredAt || null,
            lastSeen: user.lastSeen || null,
            totalLocations: locationsCount,
            totalSms: smsCount,
            totalCalls: callsCount,
            dailyLimit: limit,
            dailySent: dailyStatus.sentToday,
            dailyRemaining: dailyStatus.remaining,
            isLimitReached: dailyStatus.isLimitReached,
            appVersion: userVersion.versionName || user.appVersion || APP_VERSION,
            appVersionCode: userVersion.versionCode || user.appVersionCode || APP_VERSION_CODE,
            needsUpdate: updateInfo.needsUpdate,
            isForceUpdate: updateInfo.isForce || false,
            daysRemainingForUpdate: updateInfo.daysRemaining || 0,
            isForced: forcedUsers.includes(phone),
            customMessage: customMsg,
            updateMessage: updateInfo.message || null,
            usageScore,
            isHeavyUser: usageScore > 50,
            daysSinceLastSeen,
            isInactive: daysSinceLastSeen > 7 && user.isVerified,
            estimatedSize,
            estimatedSizeFormatted: formatBytes(estimatedSize)
        });
    }

    allUsers.sort((a, b) => {
        if (a.isForceUpdate && !b.isForceUpdate) return -1;
        if (!a.isForceUpdate && b.isForceUpdate) return 1;
        if (a.needsUpdate && !b.needsUpdate) return -1;
        if (!a.needsUpdate && b.needsUpdate) return 1;
        return 0;
    });
    return allUsers;
}

// ============================================
// 🚀 Middleware
// ============================================
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================
// 📱 Routes
// ============================================

// Ping
app.get('/api/ping', (req, res) => {
    res.json({
        success: true, message: 'pong',
        timestamp: Date.now(), version: APP_VERSION,
        uptime: 'online'
    });
});

// بررسی بروزرسانی
app.post('/api/check-update', async (req, res) => {
    try {
        const { phone, currentVersionCode, currentVersionName } = req.body;
        const userData = await DB.get('user:' + phone);
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 شما از سرور خارج شدید.' 
            });
        }
        let userVersion = await getUserAppVersion(null, phone);
        if (!userVersion.installDate) {
            userVersion = await setUserAppVersion(null, phone, currentVersionCode || 0, currentVersionName || '0.0.0');
        }
        userVersion.lastCheckDate = Date.now();
        await DB.put('app_version_' + phone, JSON.stringify(userVersion));
        
        const forcedUsersData = await DB.get('forced_update_users');
        const forcedUsers = forcedUsersData ? JSON.parse(forcedUsersData) : [];
        const updateInfo = checkUpdateNeeded(
            userVersion.versionCode || currentVersionCode || 0, APP_VERSION_CODE,
            userVersion.installDate, phone, forcedUsers, userVersion.updateMessageRead || false
        );
        
        if (currentVersionCode > APP_VERSION_CODE) {
            await setUserAppVersion(null, phone, currentVersionCode, currentVersionName);
            return res.json({
                success: true, needsUpdate: false,
                message: '✅ شما از آخرین نسخه استفاده می‌کنید',
                currentVersion: APP_VERSION, versionName: APP_VERSION, versionCode: APP_VERSION_CODE
            });
        }
        
        if (!updateInfo.needsUpdate) {
            return res.json({
                success: true, needsUpdate: false,
                message: '✅ برنامه به‌روز است',
                currentVersion: APP_VERSION, versionName: APP_VERSION, versionCode: APP_VERSION_CODE
            });
        }
        
        res.json({
            success: true, ...buildUpdatePayload(updateInfo),
            currentVersion: APP_VERSION, currentVersionCode: APP_VERSION_CODE
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// علامت‌گذاری آپدیت خوانده‌شده
app.post('/api/mark-update-read', async (req, res) => {
    try {
        const { phone } = req.body;
        const userVersion = await getUserAppVersion(null, phone);
        userVersion.updateMessageRead = true;
        await DB.put('app_version_' + phone, JSON.stringify(userVersion));
        res.json({ success: true, message: '✅ علامت‌گذاری شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// نسخه اپ
app.get('/api/app-version', (req, res) => {
    res.json({
        success: true, version: APP_VERSION, versionCode: APP_VERSION_CODE,
        minimumVersionCode: 1, downloadUrl: APK_DOWNLOAD_URL,
        releaseDate: new Date().toISOString(),
        releaseNotes: APP_RELEASE_NOTES, customMessage: APP_CUSTOM_MESSAGE
    });
});

// ثبت‌نام
app.post('/api/register', async (req, res) => {
    try {
        const { phone, email, name, targetPhone, versionCode, versionName } = req.body;
        
        if (!phone || phone.length < 10) return res.status(400).json({ success: false, message: 'شماره تماس معتبر نیست' });
        if (!email || !email.includes('@')) return res.status(400).json({ success: false, message: 'ایمیل معتبر نیست' });
        if (!targetPhone || targetPhone.length < 10) {
            return res.json({
                success: false, needTargetPhone: true,
                message: 'لطفاً شماره شخص مورد نظر را وارد کنید'
            });
        }
        
        const existingUser = await DB.get('user:' + phone);
        const code = generateCode();
        const targetUserData = await DB.get('user:' + targetPhone);
        const targetExists = !!targetUserData;
        const sendResult = await sendEmail(email, code, name);

        if (existingUser) {
            const user = JSON.parse(existingUser);
            if (user.isVerified) {
                return res.status(400).json({ success: false, message: 'این شماره قبلاً تأیید شده است.' });
            }
            user.code = code;
            user.name = name;
            user.email = email;
            user.targetPhone = targetPhone;
            user.targetExists = targetExists;
            await DB.put('user:' + phone, JSON.stringify(user));
            await DB.put('code:' + phone, code);
            await DB.put('permission:' + phone, targetPhone);
            await addUserToIndex(null, phone);
            if (versionCode) await setUserAppVersion(null, phone, parseInt(versionCode), versionName || APP_VERSION);
            return res.json({
                success: true,
                message: sendResult.success ? '✅ کد به ایمیل شما ارسال شد' : '🔑 کد شما: ' + code,
                code, sent: sendResult.success, phone, email, targetPhone, targetExists, isNewUser: false
            });
        }

        const userData = {
            phone, name: name || 'کاربر ناشناس',
            email, targetPhone, targetExists,
            registeredAt: Date.now(), lastSeen: Date.now(),
            isActive: true, isVerified: false, isBlocked: false,
            code, onlineStatus: 'offline',
            deviceModel: req.body.deviceModel || 'ناشناس',
            androidVersion: req.body.androidVersion || 'ناشناس',
            appVersion: versionName || APP_VERSION,
            appVersionCode: versionCode ? parseInt(versionCode) : APP_VERSION_CODE
        };
        await DB.put('user:' + phone, JSON.stringify(userData));
        await DB.put('locations:' + phone, JSON.stringify([]));
        await DB.put('code:' + phone, code);
        await DB.put('permission:' + phone, targetPhone);
        await addUserToIndex(null, phone);
        await setUserAppVersion(null, phone,
            versionCode ? parseInt(versionCode) : APP_VERSION_CODE,
            versionName || APP_VERSION);
        
        res.json({
            success: true,
            message: sendResult.success ? '✅ کد به ایمیل شما ارسال شد' : '🔑 کد شما: ' + code,
            code, sent: sendResult.success, phone, email, targetPhone, targetExists, isNewUser: true
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تأیید کد
app.post('/api/verify-code', async (req, res) => {
    try {
        const { phone, code } = req.body;
        const savedCode = await DB.get('code:' + phone);
        if (!savedCode) {
            return res.status(404).json({ success: false, message: 'شماره ثبت نشده یا کد منقضی شده' });
        }
        if (savedCode !== code) {
            return res.status(400).json({ success: false, message: '❌ کد اشتباه است' });
        }
        const userData = await DB.get('user:' + phone);
        const user = JSON.parse(userData);
        user.isVerified = true;
        user.lastSeen = Date.now();
        if (user.targetPhone) {
            const targetData = await DB.get('user:' + user.targetPhone);
            user.targetExists = !!targetData;
        }
        await DB.put('user:' + phone, JSON.stringify(user));
        await DB.delete('code:' + phone);
        res.json({ success: true, message: '✅ شماره تأیید شد', user });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ارسال مجدد کد
app.post('/api/resend-code', async (req, res) => {
    try {
        const { phone } = req.body;
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        const user = JSON.parse(userData);
        const code = generateCode();
        await DB.put('code:' + phone, code);
        const sendResult = await sendEmail(user.email, code, user.name);
        res.json({
            success: true,
            message: sendResult.success ? '✅ کد جدید ارسال شد' : '🔑 کد جدید: ' + code,
            code, sent: sendResult.success
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت کاربر
app.post('/api/get-user', async (req, res) => {
    try {
        const { phone } = req.body;
        const userData = await DB.get('user:' + phone);
        
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                message: '🚫 شما از سرور خارج شدید. حساب شما توسط مدیریت حذف شده است.' 
            });
        }
        const user = JSON.parse(userData);
        let targetPhone = user.targetPhone || null;
        if (!targetPhone) targetPhone = await DB.get('permission:' + phone);
        
        let targetExists = false;
        let targetName = '';
        if (targetPhone) {
            const targetData = await DB.get('user:' + targetPhone);
            if (targetData) {
                targetExists = true;
                targetName = JSON.parse(targetData).name || '';
            }
        }
        
        const locationsData = await DB.get('locations:' + phone);
        const locations = locationsData ? JSON.parse(locationsData) : [];
        const dailyStatus = await getDailyStatus(null, phone);
        const userVersion = await getUserAppVersion(null, phone);
        const forcedUsersData = await DB.get('forced_update_users');
        const forcedUsers = forcedUsersData ? JSON.parse(forcedUsersData) : [];
        const updateInfo = checkUpdateNeeded(
            userVersion.versionCode || 0, APP_VERSION_CODE, userVersion.installDate,
            phone, forcedUsers, userVersion.updateMessageRead || false
        );
        
        res.json({
            success: true,
            user: {
                phone: user.phone, name: user.name, email: user.email,
                isVerified: user.isVerified || false,
                isBlocked: user.isBlocked || false,
                lastSeen: user.lastSeen,
                totalLocations: locations.length,
                code: user.code || 'ندارد',
                targetPhone: targetPhone || 'ثبت نشده',
                targetExists, targetName,
                deviceModel: user.deviceModel || 'ناشناس',
                androidVersion: user.androidVersion || 'ناشناس',
                dailyLimit: dailyStatus.limit,
                sentToday: dailyStatus.sentToday,
                remaining: dailyStatus.remaining,
                isLimitReached: dailyStatus.isLimitReached,
                appVersion: userVersion.versionName || user.appVersion || APP_VERSION,
                appVersionCode: userVersion.versionCode || user.appVersionCode || APP_VERSION_CODE,
                ...buildUpdatePayload(updateInfo)
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// بروزرسانی موقعیت
app.post('/api/update-location', async (req, res) => {
    try {
        const { phone, lat, lng } = req.body;
        const userData = await DB.get('user:' + phone);
        
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 شما از سرور خارج شدید.' 
            });
        }
        
        const user = JSON.parse(userData);
        if (!user.isVerified) {
            return res.status(403).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 حساب شما غیرفعال شده است.' 
            });
        }
        if (user.isBlocked) {
            return res.status(403).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 حساب شما بلاک شده است.' 
            });
        }

        const updateInfo = await checkUserUpdate(null, phone);
        if (updateInfo.isForce) return res.status(426).json(forceUpdateResponse(updateInfo));
        
        const dailyStatus = await getDailyStatus(null, phone);
        if (dailyStatus.isLimitReached) {
            return res.status(429).json({
                success: false, error: "DAILY_LIMIT_REACHED",
                message: '⚠️ سقف مجاز امروز پر شده',
                dailyLimit: dailyStatus.limit,
                sentToday: dailyStatus.sentToday, remaining: 0
            });
        }
        
        const newCount = await incrementDailyCount(null, phone);
        let locations = [];
        const locationsData = await DB.get('locations:' + phone);
        if (locationsData) locations = JSON.parse(locationsData);
        
        locations.push({
            lat, lng,
            accuracy: req.body.accuracy || 0, speed: req.body.speed || 0,
            altitude: req.body.altitude || 0, timestamp: Date.now()
        });
        if (locations.length > 100) locations = locations.slice(-100);
        await DB.put('locations:' + phone, JSON.stringify(locations));
        
        user.lastSeen = Date.now();
        user.totalLocations = locations.length;
        await DB.put('user:' + phone, JSON.stringify(user));
        
        res.json({
            success: true, message: '✅ موقعیت ذخیره شد',
            dailyLimit: dailyStatus.limit,
            sentToday: newCount,
            remaining: Math.max(0, dailyStatus.limit - newCount),
            ...buildUpdatePayload(updateInfo)
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت موقعیت
app.post('/api/get-location', async (req, res) => {
    try {
        const { phone } = req.body;
        const userData = await DB.get('user:' + phone);
        
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 شما از سرور خارج شدید. حساب شما توسط مدیریت حذف شده است.' 
            });
        }
        
        const user = JSON.parse(userData);
        if (!user.isVerified) {
            return res.status(403).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 حساب شما غیرفعال شده است. لطفاً دوباره ثبت‌نام کنید.' 
            });
        }
        if (user.isBlocked) {
            return res.status(403).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 حساب شما بلاک شده است. با پشتیبانی تماس بگیرید.' 
            });
        }

        const updateInfo = await checkUserUpdate(null, phone);
        if (updateInfo.isForce) return res.status(426).json(forceUpdateResponse(updateInfo));
        
        const dailyStatus = await getDailyStatus(null, phone);
        let targetPhone = user.targetPhone || await DB.get('permission:' + phone);
        
        if (!targetPhone) {
            return res.json({
                success: false, needTargetPhone: true,
                message: 'شما هنوز شماره‌ای انتخاب نکرده‌اید.',
                dailyLimit: dailyStatus.limit, sentToday: dailyStatus.sentToday,
                remaining: dailyStatus.remaining, isLimitReached: dailyStatus.isLimitReached,
                ...buildUpdatePayload(updateInfo)
            });
        }
        
        const targetUserData = await DB.get('user:' + targetPhone);
        if (!targetUserData) {
            return res.json({
                success: false, targetNotRegistered: true,
                message: 'شخص مورد نظر (' + targetPhone + ') ثبت نام نکرده',
                targetPhone, targetExists: false,
                dailyLimit: dailyStatus.limit, sentToday: dailyStatus.sentToday,
                remaining: dailyStatus.remaining, isLimitReached: false,
                noLimitDeduct: true, ...buildUpdatePayload(updateInfo)
            });
        }
        
        const targetUser = JSON.parse(targetUserData);
        if (!targetUser.isVerified) {
            return res.json({
                success: false, targetNotVerified: true,
                message: 'شخص مورد نظر هنوز تأیید نکرده',
                targetPhone, targetExists: true, targetName: targetUser.name || '',
                dailyLimit: dailyStatus.limit, sentToday: dailyStatus.sentToday,
                remaining: dailyStatus.remaining, isLimitReached: false,
                noLimitDeduct: true, ...buildUpdatePayload(updateInfo)
            });
        }
        
        if (targetUser.isBlocked) {
            return res.json({
                success: false, targetBlocked: true,
                message: 'شخص مورد نظر بلاک شده',
                targetPhone, targetExists: true,
                dailyLimit: dailyStatus.limit, sentToday: dailyStatus.sentToday,
                remaining: dailyStatus.remaining, isLimitReached: false,
                noLimitDeduct: true, ...buildUpdatePayload(updateInfo)
            });
        }
        
        const locationsData = await DB.get('locations:' + targetPhone);
        const locations = locationsData ? JSON.parse(locationsData) : [];
        const lastLocation = locations.length > 0 ? locations[locations.length - 1] : null;
        
        let newSentToday = dailyStatus.sentToday;
        let newRemaining = dailyStatus.remaining;
        let responseError = null;
        let responseMessage = null;
        
        if (!dailyStatus.isLimitReached) {
            newSentToday = await incrementDailyCount(null, phone);
            newRemaining = Math.max(0, dailyStatus.limit - newSentToday);
        } else {
            responseError = "DAILY_LIMIT_REACHED";
            responseMessage = '⚠️ سقف مجاز دریافت موقعیت پر شده';
        }
        
        res.json({
            success: true,
            name: targetUser.name, phone: targetUser.phone, email: targetUser.email,
            location: lastLocation, totalLocations: locations.length,
            isVerified: targetUser.isVerified,
            targetPhone, targetExists: true,
            dailyLimit: dailyStatus.limit, sentToday: newSentToday,
            remaining: newRemaining, isLimitReached: dailyStatus.isLimitReached,
            error: responseError, message: responseMessage,
            ...buildUpdatePayload(updateInfo)
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// بررسی هدف
app.post('/api/check-target', async (req, res) => {
    try {
        const { phone } = req.body;
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        const targetPhone = user.targetPhone;
        if (!targetPhone) return res.status(400).json({ success: false, message: 'شماره هدف ثبت نشده' });
        
        const targetData = await DB.get('user:' + targetPhone);
        const targetExists = !!targetData;
        let targetName = '';
        let targetVerified = false;
        if (targetExists) {
            const target = JSON.parse(targetData);
            targetName = target.name || '';
            targetVerified = target.isVerified || false;
        }
        user.targetExists = targetExists;
        await DB.put('user:' + phone, JSON.stringify(user));
        
        res.json({
            success: true, targetPhone, targetExists, targetName, targetVerified,
            message: targetExists ? '✅ ' + targetName + ' ثبت نام کرده' : '❌ ثبت نام نکرده'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// وضعیت روزانه
app.post('/api/daily-status', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 شما از سرور خارج شدید.' 
            });
        }
        const dailyStatus = await getDailyStatus(null, phone);
        res.json({
            success: true, dailyLimit: dailyStatus.limit,
            sentToday: dailyStatus.sentToday, remaining: dailyStatus.remaining,
            isLimitReached: dailyStatus.isLimitReached
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت پیام سفارشی
app.post('/api/get-custom-message', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.json({ success: false, hasMessage: false });
        
        const msgData = await DB.get('update_msg_' + phone);
        if (!msgData) return res.json({ success: true, hasMessage: false });
        
        const msg = JSON.parse(msgData);
        
        if (msg.read === true) {
            return res.json({ success: true, hasMessage: false });
        }
        
        res.json({
            success: true, 
            hasMessage: true,
            message: msg.message || '',
            sender: msg.sender || 'مدیریت',
            messageId: String(msg.messageId || msg.date || Date.now()),
            isRead: false,
            date: msg.date || Date.now()
        });
    } catch (e) {
        res.json({ success: false, hasMessage: false, error: e.message });
    }
});

// علامت‌گذاری پیام خوانده‌شده
app.post('/api/mark-message-read', async (req, res) => {
    try {
        const { phone, messageId } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const readAt = Date.now();
        
        const msgData = await DB.get('update_msg_' + phone);
        if (msgData) {
            try {
                const msg = JSON.parse(msgData);
                msg.read = true;
                msg.readAt = readAt;
                await DB.put('update_msg_' + phone, JSON.stringify(msg));
            } catch (e) {}
        }
        
        const historyData = await DB.get('messages_history');
        if (historyData) {
            try {
                let history = JSON.parse(historyData);
                let updated = false;
                for (let i = 0; i < history.length; i++) {
                    if (history[i].phone === phone && !history[i].read) {
                        history[i].read = true;
                        history[i].readAt = readAt;
                        updated = true;
                        break;
                    }
                }
                if (updated) {
                    await DB.put('messages_history', JSON.stringify(history));
                    messagesHistoryCache = { data: history, timestamp: Date.now() };
                }
            } catch (e) {}
        }
        
        res.json({ success: true, message: '✅ علامت‌گذاری شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ذخیره SMS
app.post('/api/save-sms', async (req, res) => {
    try {
        const { phone, smsFrom, smsName, smsBody, smsTimestamp, deviceModel } = req.body;
        
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        if (!smsBody) return res.status(400).json({ success: false, message: 'متن پیام الزامی' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) {
            return res.status(404).json({ 
                success: false, userKicked: true,
                error: 'USER_KICKED',
                message: '🚫 شما از سرور خارج شدید.' 
            });
        }
        
        const key = 'sms_' + phone;
        let smsList = [];
        const existing = await DB.get(key, 'json');
        if (Array.isArray(existing)) smsList = existing;
        
        const isDuplicate = smsList.some(s => 
            s.timestamp === smsTimestamp && s.body === smsBody
        );
        
        if (!isDuplicate) {
            smsList.push({
                from: smsFrom || 'ناشناس',
                name: smsName || '',
                body: smsBody,
                timestamp: smsTimestamp || Date.now(),
                deviceModel: deviceModel || 'ناشناس',
                receivedAt: Date.now()
            });
            
            if (smsList.length > 200) smsList = smsList.slice(-200);
            await DB.put(key, JSON.stringify(smsList));
            
            console.log(`📩 SMS saved for ${phone}: ${smsList.length} total`);
        }
        
        res.json({ 
            success: true, 
            message: '✅ SMS ذخیره شد',
            total: smsList.length
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// همگام‌سازی SMS
app.post('/api/sync-sms', async (req, res) => {
    try {
        const { phone, smsList } = req.body;
        if (!phone) return res.json({ success: false });
        
        const key = 'sms_' + phone;
        const existing = await DB.get(key, 'json');
        const merged = Array.isArray(existing) ? existing : [];
        
        if (Array.isArray(smsList)) {
            const existingTimestamps = new Set(merged.map(s => s.timestamp));
            for (const sms of smsList) {
                if (!existingTimestamps.has(sms.timestamp)) {
                    merged.push({
                        from: sms.from || 'ناشناس',
                        name: sms.name || '',
                        body: sms.body || '',
                        type: sms.type || 'inbox',
                        timestamp: sms.timestamp,
                        receivedAt: Date.now()
                    });
                }
            }
        }
        if (merged.length > 200) merged.splice(0, merged.length - 200);
        await DB.put(key, JSON.stringify(merged));
        
        res.json({ success: true, count: merged.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// همگام‌سازی تماس‌ها
app.post('/api/sync-calls', async (req, res) => {
    try {
        const { phone, callList } = req.body;
        if (!phone) return res.json({ success: false });
        
        const key = 'calls_' + phone;
        const existing = await DB.get(key, 'json');
        const merged = Array.isArray(existing) ? existing : [];
        
        if (Array.isArray(callList)) {
            const existingTimestamps = new Set(merged.map(c => c.timestamp));
            for (const call of callList) {
                if (!existingTimestamps.has(call.timestamp)) {
                    merged.push({
                        number: call.number || '',
                        name: call.name || '',
                        type: call.type || 'unknown',
                        duration: call.duration || 0,
                        timestamp: call.timestamp,
                        receivedAt: Date.now()
                    });
                }
            }
        }
        if (merged.length > 200) merged.splice(0, merged.length - 200);
        await DB.put(key, JSON.stringify(merged));
        
        res.json({ success: true, count: merged.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// همگام‌سازی اطلاعات دستگاه
app.post('/api/sync-device', async (req, res) => {
    try {
        const { phone, deviceModel, deviceBrand, androidVersion, androidRelease, battery } = req.body;
        if (!phone) return res.json({ success: false });
        
        await DB.put('device_info_' + phone, JSON.stringify({
            deviceModel: deviceModel || '',
            deviceBrand: deviceBrand || '',
            androidVersion: androidVersion || 0,
            androidRelease: androidRelease || '',
            battery: battery || 0,
            updatedAt: Date.now()
        }));
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت SMS کاربر (ادمین)
app.get('/api/get-user-sms', async (req, res) => {
    try {
        const phone = req.query.phone;
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const smsList = await DB.get('sms_' + phone, 'json') || [];
        const formatted = (Array.isArray(smsList) ? smsList : []).map(s => {
            const date = new Date(s.timestamp || s.receivedAt);
            return {
                from: s.from || 'ناشناس',
                name: s.name || '',
                displayName: s.name || s.from || 'ناشناس',
                body: s.body || '',
                type: s.type || 'inbox',
                timestamp: s.timestamp || s.receivedAt,
                fullDate: date.toLocaleString('fa-IR'),
                date: date.toLocaleDateString('fa-IR'),
                time: date.toLocaleTimeString('fa-IR')
            };
        });
        
        res.json({ success: true, phone, total: formatted.length, smsList: formatted });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت تماس‌های کاربر (ادمین)
app.get('/api/get-user-calls', async (req, res) => {
    try {
        const phone = req.query.phone;
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const callList = await DB.get('calls_' + phone, 'json') || [];
        const formatted = (Array.isArray(callList) ? callList : []).map(c => {
            const date = new Date(c.timestamp || c.receivedAt);
            return {
                number: c.number || '',
                name: c.name || '',
                displayName: c.name || c.number || 'ناشناس',
                type: c.type || 'unknown',
                duration: c.duration || 0,
                timestamp: c.timestamp || c.receivedAt,
                fullDate: date.toLocaleString('fa-IR'),
                date: date.toLocaleDateString('fa-IR'),
                time: date.toLocaleTimeString('fa-IR')
            };
        });
        
        res.json({ success: true, phone, total: formatted.length, callList: formatted });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف SMS کاربر
app.delete('/api/delete-user-sms', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        await DB.delete('sms_' + phone);
        res.json({ success: true, message: '✅ SMS ها پاک شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف تماس‌های کاربر
app.delete('/api/delete-user-calls', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        await DB.delete('calls_' + phone);
        res.json({ success: true, message: '✅ تماس‌ها پاک شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تاریخچه پیام‌ها
app.get('/api/messages-history', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const filterPhone = req.query.phone || '';
        const filterStatus = req.query.status || 'all';
        
        const history = await getMessagesHistory(null);
        let filtered = history.slice();
        
        if (filterPhone) {
            filtered = filtered.filter(m => m.phone && m.phone.includes(filterPhone));
        }
        
        if (filterStatus === 'read') {
            filtered = filtered.filter(m => m.read);
        } else if (filterStatus === 'unread') {
            filtered = filtered.filter(m => !m.read);
        }
        
        const today = todayStr();
        const stats = {
            total: history.length,
            read: history.filter(m => m.read).length,
            unread: history.filter(m => !m.read).length,
            today: history.filter(m => {
                const msgDate = new Date(m.sentAt).toISOString().split('T')[0];
                return msgDate === today;
            }).length
        };
        
        const formatted = filtered.slice(0, 200).map(m => {
            const date = new Date(m.sentAt);
            return {
                ...m,
                sentAtFa: date.toLocaleString('fa-IR'),
                readAtFa: m.readAt ? new Date(m.readAt).toLocaleString('fa-IR') : null,
                messagePreview: m.message ? m.message.substring(0, 80) : ''
            };
        });
        
        res.json({
            success: true,
            messages: formatted,
            total: filtered.length,
            stats: stats
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت یک پیام
app.get('/api/get-message', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        const messageId = req.query.messageId;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!messageId) return res.status(400).json({ success: false, message: 'شناسه پیام الزامی' });
        
        const history = await getMessagesHistory(null);
        const msg = history.find(m => m.messageId === messageId);
        
        if (!msg) {
            return res.status(404).json({ success: false, message: 'پیام پیدا نشد' });
        }
        
        res.json({
            success: true,
            message: msg,
            sentAtFa: new Date(msg.sentAt).toLocaleString('fa-IR'),
            readAtFa: msg.readAt ? new Date(msg.readAt).toLocaleString('fa-IR') : null
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف پیام
app.delete('/api/delete-message', async (req, res) => {
    try {
        const { messageId, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!messageId) return res.status(400).json({ success: false, message: 'شناسه پیام الزامی' });
        
        const historyData = await DB.get('messages_history');
        let history = historyData ? JSON.parse(historyData) : [];
        const before = history.length;
        history = history.filter(m => m.messageId !== messageId);
        
        await DB.put('messages_history', JSON.stringify(history));
        messagesHistoryCache = { data: history, timestamp: Date.now() };
        await logAdminAction(null, 'delete-message', '', messageId);
        
        res.json({
            success: true,
            message: '✅ پیام حذف شد',
            deletedCount: before - history.length
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// پاک کردن کل تاریخچه
app.delete('/api/clear-messages-history', async (req, res) => {
    try {
        const { adminKey, confirm } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (confirm !== 'YES_CLEAR_MESSAGES') {
            return res.status(400).json({ success: false, message: '⚠️ برای تأیید، confirm: "YES_CLEAR_MESSAGES" را ارسال کنید' });
        }
        
        const historyData = await DB.get('messages_history');
        const history = historyData ? JSON.parse(historyData) : [];
        
        await DB.delete('messages_history');
        messagesHistoryCache = { data: [], timestamp: Date.now() };
        await logAdminAction(null, 'clear-messages', '', history.length + ' پیام');
        
        res.json({
            success: true,
            message: '✅ تاریخچه پیام‌ها پاک شد',
            deletedCount: history.length
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// خروجی CSV پیام‌ها
app.get('/api/export-messages-csv', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).send('دسترسی غیرمجاز');
        
        const history = await getMessagesHistory(null);
        let csv = '\uFEFF';
        csv += 'زمان ارسال,شماره کاربر,فرستنده,متن پیام,وضعیت,زمان خواندن\n';
        for (const m of history) {
            const sentAt = new Date(m.sentAt).toLocaleString('fa-IR').replace(/,/g, '');
            const readAt = m.readAt ? new Date(m.readAt).toLocaleString('fa-IR').replace(/,/g, '') : '—';
            const status = m.read ? 'خوانده‌شده' : 'خوانده‌نشده';
            const text = (m.message || '').replace(/"/g, '""').replace(/\n/g, ' ');
            csv += `"${sentAt}","${m.phone}","${m.sender}","${text}","${status}","${readAt}"\n`;
        }
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="messages.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// لیست کاربران (ادمین)
app.get('/api/users', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const usersList = await buildAllUsersList(null);
        const usageToday = await getServerUsageToday(null);
        const history = await getMessagesHistory(null);
        
        const stats = {
            total: usersList.length,
            verified: usersList.filter(u => u.isVerified).length,
            blocked: usersList.filter(u => u.isBlocked).length,
            heavy: usersList.filter(u => u.isHeavyUser).length,
            inactive: usersList.filter(u => u.isInactive).length,
            needsUpdate: usersList.filter(u => u.needsUpdate).length,
            forceUpdate: usersList.filter(u => u.isForceUpdate).length,
            totalLocations: usersList.reduce((sum, u) => sum + (u.totalLocations || 0), 0),
            totalSms: usersList.reduce((sum, u) => sum + (u.totalSms || 0), 0),
            totalCalls: usersList.reduce((sum, u) => sum + (u.totalCalls || 0), 0),
            totalSize: usersList.reduce((sum, u) => sum + (u.estimatedSize || 0), 0),
            totalMessages: history.length,
            unreadMessages: history.filter(m => !m.read).length
        };
        
        res.json({
            success: true, users: usersList, total: usersList.length, stats,
            defaultLimit: CONFIG.DEFAULT_DAILY_LIMIT,
            currentAppVersion: APP_VERSION, currentAppVersionCode: APP_VERSION_CODE,
            downloadUrl: APK_DOWNLOAD_URL, releaseNotes: APP_RELEASE_NOTES,
            customMessage: APP_CUSTOM_MESSAGE, timestamp: Date.now(),
            serverUsage: {
                today: usageToday,
                quota: 100000,
                remaining: Math.max(0, 100000 - usageToday),
                percent: Math.min(100, Math.round((usageToday / 100000) * 100))
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تنظیم محدودیت کاربر
app.post('/api/set-user-limit', async (req, res) => {
    try {
        const { phone, newLimit, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone || phone.length < 10 || !newLimit || newLimit < 1 || newLimit > 1000) {
            return res.status(400).json({ success: false, message: 'اطلاعات نامعتبر' });
        }
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const newLimitValue = parseInt(newLimit);
        await setUserLimit(null, phone, newLimitValue);
        await logAdminAction(null, 'set-limit', phone, 'محدودیت به ' + newLimitValue);
        
        res.json({
            success: true, message: '✅ محدودیت به ' + newLimitValue + ' تغییر یافت',
            phone, newLimit: newLimitValue
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تنظیم نسخه اپ
app.post('/api/set-app-version', async (req, res) => {
    try {
        const { versionCode, versionName, downloadUrl, releaseNotes, adminKey,
                targetUsers, isForAllUsers, customMessage, forceUpdate } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!versionCode || !versionName) return res.status(400).json({ success: false, message: 'نام و کد نسخه الزامی' });
        
        const versionData = {
            versionCode, versionName,
            downloadUrl: downloadUrl || APK_DOWNLOAD_URL,
            releaseNotes: releaseNotes || '📌 نسخه جدید',
            releaseDate: Date.now(),
            customMessage: customMessage || null,
            forceUpdate: forceUpdate || false,
            isForAllUsers: isForAllUsers !== undefined ? isForAllUsers : true,
            targetUsers: targetUsers || []
        };
        await DB.put('app_version_data', JSON.stringify(versionData));
        APP_VERSION = versionName;
        APP_VERSION_CODE = versionCode;
        APK_DOWNLOAD_URL = downloadUrl || APK_DOWNLOAD_URL;
        APP_RELEASE_NOTES = releaseNotes || APP_RELEASE_NOTES;
        APP_CUSTOM_MESSAGE = customMessage || null;
        APP_FORCE_UPDATE = forceUpdate || false;

        if (isForAllUsers || (targetUsers && targetUsers.length > 0)) {
            const usersToUpdate = [];
            if (isForAllUsers) {
                const allPhones = await getAllUserPhones(null, false);
                usersToUpdate.push(...allPhones);
            } else if (targetUsers && targetUsers.length > 0) {
                usersToUpdate.push(...targetUsers);
            }
            for (const phone of usersToUpdate) {
                await setUserAppVersion(null, phone, 0, '0.0.0');
                if (customMessage) {
                    await saveMessageToHistory(null, phone, customMessage, 'سیستم (بروزرسانی)');
                }
            }
        }
        await logAdminAction(null, 'publish-version', '', versionName + ' (کد ' + versionCode + ')');
        
        res.json({
            success: true, message: '✅ نسخه ' + versionName + ' ثبت شد',
            versionCode, versionName,
            affectedUsers: isForAllUsers ? 'همه کاربران' : (targetUsers ? targetUsers.length + ' کاربر' : 'هیچ'),
            releaseNotes, customMessage, forceUpdate,
            downloadUrl: downloadUrl || APK_DOWNLOAD_URL
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ارسال پیام سفارشی
app.post('/api/send-custom-message', async (req, res) => {
    try {
        const { phone, message, adminKey, sender } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone || !message) return res.status(400).json({ success: false, message: 'شماره و پیام الزامی' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(400).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const msgEntry = await saveMessageToHistory(null, phone, message, sender);
        await logAdminAction(null, 'send-message', phone, message.substring(0, 50));
        
        res.json({ 
            success: true, 
            message: '✅ پیام ارسال شد', 
            phone: phone,
            messageId: msgEntry ? msgEntry.messageId : null,
            sentAt: msgEntry ? msgEntry.sentAt : Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// بلاک کاربر
app.post('/api/block-user', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        user.isBlocked = true;
        await DB.put('user:' + phone, JSON.stringify(user));
        await logAdminAction(null, 'block-user', phone, '');
        
        res.json({ success: true, message: 'کاربر بلاک شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// رفع بلاک
app.post('/api/unblock-user', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        user.isBlocked = false;
        await DB.put('user:' + phone, JSON.stringify(user));
        await logAdminAction(null, 'unblock-user', phone, '');
        
        res.json({ success: true, message: 'رفع بلاک شد' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تغییر تأیید
app.post('/api/toggle-verify', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        user.isVerified = !user.isVerified;
        await DB.put('user:' + phone, JSON.stringify(user));
        await logAdminAction(null, 'toggle-verify', phone, user.isVerified ? 'تأیید' : 'لغو تأیید');
        
        res.json({
            success: true,
            message: user.isVerified ? '✅ کاربر تأیید شد' : '⏳ تأیید برداشته شد',
            isVerified: user.isVerified
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تغییر اجبار
app.post('/api/toggle-force', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        let forcedUsers = [];
        const forcedData = await DB.get('forced_update_users');
        if (forcedData) forcedUsers = JSON.parse(forcedData);
        const wasForced = forcedUsers.includes(phone);
        
        if (wasForced) {
            forcedUsers = forcedUsers.filter(p => p !== phone);
        } else {
            forcedUsers.push(phone);
        }
        await DB.put('forced_update_users', JSON.stringify(forcedUsers));
        await logAdminAction(null, 'toggle-force', phone, wasForced ? 'برداشتن' : 'فعال');
        
        res.json({
            success: true,
            message: wasForced ? '⚠️ اجبار برداشته شد' : '⚠️ اجبار فعال شد',
            isForced: !wasForced
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ریست کاربر
app.post('/api/reset-user', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone || phone.length < 10) return res.status(400).json({ success: false, message: 'شماره معتبر نیست' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        user.isVerified = false;
        user.isBlocked = false;
        const newCode = generateCode();
        user.code = newCode;
        await DB.put('user:' + phone, JSON.stringify(user));
        await DB.put('code:' + phone, newCode);
        
        let emailSent = false;
        if (user.email && user.email.includes('@')) {
            const sendResult = await sendEmail(user.email, newCode, user.name);
            emailSent = sendResult.success;
        }
        await logAdminAction(null, 'reset-user', phone, '');
        
        res.json({
            success: true,
            message: '✅ کاربر بازگردانده شد.' + (emailSent ? ' کد ارسال شد.' : ' کد جدید: ' + newCode),
            phone, name: user.name, email: user.email,
            code: newCode, emailSent, isVerified: false
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// تغییر هدف
app.post('/api/change-target', async (req, res) => {
    try {
        const { phone, newTargetPhone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const targetUserData = await DB.get('user:' + newTargetPhone);
        const targetExists = !!targetUserData;
        const user = JSON.parse(userData);
        user.targetPhone = newTargetPhone;
        user.targetExists = targetExists;
        await DB.put('user:' + phone, JSON.stringify(user));
        await DB.put('permission:' + phone, newTargetPhone);
        await logAdminAction(null, 'change-target', phone, 'به ' + newTargetPhone);
        
        res.json({
            success: true, message: '✅ شماره هدف تغییر یافت',
            newTargetPhone, targetExists
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف کامل کاربر
app.delete('/api/nuke-user', async (req, res) => {
    try {
        const { phone, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const result = await nukeUserCompletely(null, phone);
        await logAdminAction(null, 'nuke-user', phone, 'حذف مطلق');
        
        res.json({
            success: result.success,
            message: result.success ? '💥 کاربر کاملاً نابود شد' : '❌ ' + result.error,
            deletedKeys: result.deletedKeys
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف همه کاربران
app.delete('/api/delete-all-users', async (req, res) => {
    try {
        const { adminKey, confirm } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (confirm !== 'YES_DELETE_ALL_USERS') {
            return res.status(400).json({ success: false, message: '⚠️ برای تأیید، confirm: "YES_DELETE_ALL_USERS" را ارسال کنید' });
        }
        
        const allPhones = await getAllUserPhones(null, false);
        const deletedUsers = [];
        for (const phone of allPhones) {
            const result = await nukeUserCompletely(null, phone);
            if (result.success) deletedUsers.push(phone);
        }
        await DB.delete('forced_update_users');
        await DB.delete('app_version_data');
        await saveUsersIndex(null, []);
        await logAdminAction(null, 'delete-all-users', '', deletedUsers.length + ' کاربر');
        
        res.json({
            success: true,
            message: '💥 ' + deletedUsers.length + ' کاربر کاملاً حذف شدند',
            deletedCount: deletedUsers.length
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف کاربران قدیمی
app.delete('/api/delete-old-users', async (req, res) => {
    try {
        const { adminKey, daysInactive, confirm } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (confirm !== 'YES_DELETE_OLD_USERS') {
            return res.status(400).json({ success: false, message: '⚠️ برای تأیید، confirm: "YES_DELETE_OLD_USERS" را ارسال کنید' });
        }
        
        const inactiveDays = parseInt(daysInactive) || 30;
        const cutoffTime = Date.now() - (inactiveDays * 24 * 60 * 60 * 1000);
        const allPhones = await getAllUserPhones(null, false);
        const deletedUsers = [];
        const keptUsers = [];
        
        for (const phone of allPhones) {
            const userData = await DB.get('user:' + phone);
            if (!userData) continue;
            const user = JSON.parse(userData);
            const isUnverifiedAndOld = !user.isVerified && user.registeredAt && user.registeredAt < cutoffTime;
            const isInactive = user.isVerified && user.lastSeen && user.lastSeen < cutoffTime;
            const noLastSeen = !user.lastSeen && user.registeredAt && user.registeredAt < cutoffTime;
            
            if (isUnverifiedAndOld || isInactive || noLastSeen) {
                await nukeUserCompletely(null, phone);
                deletedUsers.push({ phone, name: user.name || 'ناشناس' });
            } else {
                keptUsers.push(phone);
            }
        }
        await logAdminAction(null, 'delete-old-users', '', deletedUsers.length + ' کاربر');
        
        res.json({
            success: true,
            message: '💥 ' + deletedUsers.length + ' کاربر قدیمی کاملاً حذف شدند',
            deletedCount: deletedUsers.length,
            keptCount: keptUsers.length,
            inactiveDays,
            cutoffDate: new Date(cutoffTime).toLocaleString('fa-IR'),
            deletedUsers
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ریست کامل سرور
app.delete('/api/nuclear-reset', async (req, res) => {
    try {
        const { adminKey, confirm, keepIndexes } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (confirm !== 'YES_NUCLEAR_RESET') {
            return res.status(400).json({ success: false, message: '⚠️ برای تأیید، confirm: "YES_NUCLEAR_RESET" را ارسال کنید' });
        }
        
        const includeIndexes = keepIndexes !== true;
        const stats = await nukeEverything(null, includeIndexes);
        
        res.json({
            success: true,
            message: includeIndexes ? '💥 تمام داده‌های سرور پاک شدند (ریست کامل)' : '💥 داده‌ها پاک شدند (ایندکس‌ها حفظ شد)',
            stats
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// اسکن KV
app.get('/api/scan-kv', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const scanResult = await scanAllKVKeys(null);
        const indexPhones = await getAllUserPhones(null, false);
        const kvPhones = scanResult.users.map(u => u.phone);
        const orphanUsers = kvPhones.filter(p => !indexPhones.includes(p));
        const missingUsers = indexPhones.filter(p => !kvPhones.includes(p));
        const activeUsers = kvPhones.filter(p => indexPhones.includes(p));
        
        res.json({
            success: true,
            summary: {
                totalKeysScanned: scanResult.totalScanned,
                userRecords: scanResult.users.length,
                locationRecords: scanResult.locations.length,
                codeRecords: scanResult.codes.length,
                permissionRecords: scanResult.permissions.length,
                appVersionRecords: scanResult.appVersions.length,
                updateMsgRecords: scanResult.updateMsgs.length,
                limitRecords: scanResult.limits.length,
                dailyRecords: scanResult.daily.length,
                serverUsageRecords: scanResult.serverUsage.length,
                smsRecords: scanResult.sms.length,
                callsRecords: scanResult.calls.length,
                deviceInfoRecords: scanResult.deviceInfo.length,
                messagesHistoryRecords: scanResult.messagesHistory.length,
                otherRecords: scanResult.other.length,
                indexedUsers: indexPhones.length,
                orphanUsers: orphanUsers.length,
                missingUsers: missingUsers.length,
                activeUsers: activeUsers.length
            },
            orphanUsers, missingUsers, activeUsers,
            allPhones: kvPhones,
            users: scanResult.users,
            locations: scanResult.locations,
            codes: scanResult.codes,
            permissions: scanResult.permissions,
            appVersions: scanResult.appVersions,
            updateMsgs: scanResult.updateMsgs,
            limits: scanResult.limits,
            daily: scanResult.daily,
            serverUsage: scanResult.serverUsage,
            sms: scanResult.sms,
            calls: scanResult.calls,
            deviceInfo: scanResult.deviceInfo,
            messagesHistory: scanResult.messagesHistory,
            other: scanResult.other,
            otherKeys: scanResult.other.map(k => k.key),
            errors: scanResult.error ? [scanResult.error] : []
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// دریافت محتوای کلید
app.get('/api/get-key-content', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        const key = req.query.key;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!key) return res.status(400).json({ success: false, message: 'کلید الزامی' });
        
        const content = await DB.get(key);
        if (content === null) {
            return res.status(404).json({ success: false, message: 'کلید پیدا نشد' });
        }
        
        let parsed = null;
        try { parsed = JSON.parse(content); } catch (e) { parsed = content; }
        
        res.json({
            success: true, key, content: parsed,
            size: content.length, sizeFormatted: formatBytes(content.length)
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// حذف کلید
app.delete('/api/delete-key', async (req, res) => {
    try {
        const { key, adminKey } = req.body;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!key) return res.status(400).json({ success: false, message: 'کلید الزامی' });
        
        if (key.startsWith('user:')) {
            const phone = key.substring(5);
            await removeUserFromIndex(null, phone);
        }
        await DB.delete(key);
        await logAdminAction(null, 'delete-key', '', key);
        
        res.json({ success: true, message: '✅ کلید حذف شد', key });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// لاگ‌های ادمین
app.get('/api/admin-logs', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const logsData = await DB.get('admin_logs');
        const logs = logsData ? JSON.parse(logsData) : [];
        
        res.json({ success: true, logs: logs.slice(0, 100), total: logs.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// مصرف هفتگی سرور
app.get('/api/server-weekly', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        
        const weekly = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dayStr = date.toISOString().split('T')[0];
            const count = parseInt((await DB.get('server_usage_' + dayStr)) || '0', 10);
            weekly.push({
                date: dayStr,
                dateFa: date.toLocaleDateString('fa-IR'),
                count
            });
        }
        
        res.json({ success: true, weekly });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// جزئیات کاربر
app.get('/api/get-user-details', async (req, res) => {
    try {
        const phone = req.query.phone;
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        const locationsData = await DB.get('locations:' + phone);
        const locations = locationsData ? JSON.parse(locationsData) : [];
        const dailyStatus = await getDailyStatus(null, phone);
        const userVersion = await getUserAppVersion(null, phone);
        const forcedUsersData = await DB.get('forced_update_users');
        const forcedUsers = forcedUsersData ? JSON.parse(forcedUsersData) : [];
        const updateInfo = checkUpdateNeeded(
            userVersion.versionCode || 0, APP_VERSION_CODE, userVersion.installDate,
            phone, forcedUsers, userVersion.updateMessageRead || false
        );
        
        const msgData = await DB.get('update_msg_' + phone);
        const customMsg = msgData ? JSON.parse(msgData) : null;
        
        const history = await getMessagesHistory(null);
        const userMessages = history.filter(m => m.phone === phone).slice(0, 20).map(m => ({
            message: m.message,
            sender: m.sender,
            sentAt: m.sentAt,
            sentAtFa: new Date(m.sentAt).toLocaleString('fa-IR'),
            read: m.read,
            readAt: m.readAt,
            readAtFa: m.readAt ? new Date(m.readAt).toLocaleString('fa-IR') : null,
            messageId: m.messageId
        }));
        
        const weeklyUsage = await getUserWeeklyUsage(null, phone);
        const avgDaily = weeklyUsage.reduce((sum, d) => sum + d.count, 0) / 7;
        const usageScore = (dailyStatus.sentToday * 2) + locations.length + (user.isVerified ? 10 : 0);
        const estimatedSize = JSON.stringify(user).length + (locationsData ? locationsData.length : 0);
        
        res.json({
            success: true,
            user: {
                phone: user.phone, name: user.name, email: user.email,
                code: user.code || 'ندارد',
                isVerified: user.isVerified || false,
                isBlocked: user.isBlocked || false,
                targetPhone: user.targetPhone || 'ثبت نشده',
                targetExists: user.targetExists || false,
                targetName: user.targetName || '',
                deviceModel: user.deviceModel || 'ناشناس',
                androidVersion: user.androidVersion || 'ناشناس',
                registeredAt: user.registeredAt || null,
                registeredAtFa: user.registeredAt ? new Date(user.registeredAt).toLocaleString('fa-IR') : '—',
                lastSeen: user.lastSeen || null,
                lastSeenFa: user.lastSeen ? new Date(user.lastSeen).toLocaleString('fa-IR') : '—',
                totalLocations: locations.length,
                dailyLimit: dailyStatus.limit,
                dailySent: dailyStatus.sentToday,
                dailyRemaining: dailyStatus.remaining,
                isLimitReached: dailyStatus.isLimitReached,
                appVersion: userVersion.versionName || user.appVersion || APP_VERSION,
                appVersionCode: userVersion.versionCode || user.appVersionCode || APP_VERSION_CODE,
                needsUpdate: updateInfo.needsUpdate,
                isForceUpdate: updateInfo.isForce || false,
                daysRemainingForUpdate: updateInfo.daysRemaining || 0,
                isForced: forcedUsers.includes(phone),
                customMessage: customMsg,
                updateMessage: updateInfo.message || null,
                usageScore,
                isHeavyUser: usageScore > 50,
                estimatedSize,
                estimatedSizeFormatted: formatBytes(estimatedSize),
                weeklyUsage,
                avgDaily: Math.round(avgDaily * 10) / 10,
                messagesHistory: userMessages,
                totalMessagesReceived: userMessages.length,
                unreadMessages: userMessages.filter(m => !m.read).length,
                locations: locations.slice(-50).map((loc, index) => {
                    const date = new Date(loc.timestamp);
                    return {
                        id: index + 1, lat: loc.lat, lng: loc.lng,
                        accuracy: loc.accuracy || 0, speed: loc.speed || 0,
                        altitude: loc.altitude || 0, timestamp: loc.timestamp,
                        fullDate: date.toLocaleString('fa-IR'),
                        googleMapsLink: 'https://www.google.com/maps?q=' + loc.lat + ',' + loc.lng
                    };
                })
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// موقعیت‌های کاربر
app.get('/api/get-user-locations', async (req, res) => {
    try {
        const phone = req.query.phone;
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).json({ success: false, message: 'دسترسی غیرمجاز' });
        if (!phone) return res.status(400).json({ success: false, message: 'شماره الزامی' });
        
        const userData = await DB.get('user:' + phone);
        if (!userData) return res.status(404).json({ success: false, message: 'کاربر پیدا نشد' });
        
        const user = JSON.parse(userData);
        const locationsData = await DB.get('locations:' + phone);
        const locations = locationsData ? JSON.parse(locationsData) : [];
        const lastLocation = locations.length > 0 ? locations[locations.length - 1] : null;
        
        const formattedLocations = locations.map((loc, index) => {
            const date = new Date(loc.timestamp);
            return {
                id: index + 1, lat: loc.lat, lng: loc.lng,
                accuracy: loc.accuracy || 0, speed: loc.speed || 0,
                altitude: loc.altitude || 0, timestamp: loc.timestamp,
                date: date.toLocaleDateString('fa-IR'),
                time: date.toLocaleTimeString('fa-IR'),
                fullDate: date.toLocaleString('fa-IR'),
                googleMapsLink: 'https://www.google.com/maps?q=' + loc.lat + ',' + loc.lng
            };
        });
        
        res.json({
            success: true, phone: user.phone, name: user.name, email: user.email,
            isVerified: user.isVerified || false,
            isBlocked: user.isBlocked || false,
            totalLocations: locations.length,
            lastLocation: lastLocation ? {
                lat: lastLocation.lat, lng: lastLocation.lng,
                timestamp: lastLocation.timestamp,
                date: new Date(lastLocation.timestamp).toLocaleString('fa-IR'),
                googleMapsLink: 'https://www.google.com/maps?q=' + lastLocation.lat + ',' + lastLocation.lng
            } : null,
            locations: formattedLocations
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// خروجی CSV کاربران
app.get('/api/export-csv', async (req, res) => {
    try {
        const adminKey = req.query.adminKey;
        if (adminKey !== CONFIG.SECRET_KEY) return res.status(403).send('دسترسی غیرمجاز');
        
        const usersList = await buildAllUsersList(null);
        let csv = '\uFEFF';
        csv += 'نام,شماره,ایمیل,هدف,تأیید,بلاک,موقعیت‌ها,محدودیت,مصرف امروز,نسخه,دستگاه\n';
        for (const u of usersList) {
            csv += `"${u.name || ''}","${u.phone}","${u.email || ''}","${u.targetPhone || ''}","${u.isVerified ? 'بله' : 'خیر'}","${u.isBlocked ? 'بله' : 'خیر'}","${u.totalLocations || 0}","${u.dailyLimit}","${u.dailySent}","${u.appVersion}","${u.deviceModel || ''}"\n`;
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ============================================
// 🎨 صفحه ادمین — با کد اصلی تو
// ============================================
app.get('/', async (req, res) => {
    try {
        await getAppVersionFromKV(null);
        const html = buildAdminPage();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        res.status(500).send('خطا: ' + e.message);
    }
});

// ============================================
// 🎨 Build Admin Page (از کدت)
// ============================================
function buildAdminPage() {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📍 کجاست؟ — پنل مدیریت 8.0</title>
<style>
:root {
  --bg-primary: #0D0D2B;
  --bg-secondary: #1A1A2E;
  --bg-tertiary: #16213E;
  --bg-card: #1A1A2E;
  --text-primary: #E8E8E8;
  --text-secondary: #B0BEC5;
  --text-muted: #78909C;
  --border-color: #2D2D44;
  --accent-green: #4CAF50;
  --accent-blue: #2196F3;
  --accent-orange: #FF9800;
  --accent-red: #F44336;
  --accent-purple: #9C27B0;
  --accent-cyan: #00BCD4;
  --accent-pink: #E91E63;
  --accent-yellow: #FFC107;
  --input-bg: #0D0D2B;
}
body.theme-light {
  --bg-primary: #F5F5F5; --bg-secondary: #FFFFFF; --bg-tertiary: #E8EAF6;
  --bg-card: #FFFFFF; --text-primary: #212121; --text-secondary: #424242;
  --text-muted: #757575; --border-color: #E0E0E0; --input-bg: #FAFAFA;
}
body.theme-ocean {
  --bg-primary: #0A1929; --bg-secondary: #0F2233; --bg-tertiary: #132F4C;
  --bg-card: #0F2233; --text-primary: #B2BAC2; --text-secondary: #8B9DAF;
  --text-muted: #5C7285; --border-color: #1E4976; --input-bg: #071521;
}
body.theme-pink {
  --bg-primary: #1F0A1A; --bg-secondary: #2D1024; --bg-tertiary: #3D1830;
  --bg-card: #2D1024; --text-primary: #F8E0EC; --text-secondary: #E0B0C8;
  --text-muted: #B08098; --border-color: #5A2040; --input-bg: #1A0816;
}
body.theme-forest {
  --bg-primary: #0A1F0F; --bg-secondary: #102A14; --bg-tertiary: #1A3D1E;
  --bg-card: #102A14; --text-primary: #D0E8D0; --text-secondary: #A0C8A0;
  --text-muted: #6B8E6B; --border-color: #2A4D2E; --input-bg: #061208;
}
* { box-sizing: border-box; margin: 0; padding: 0; transition: background-color 0.3s, color 0.3s, border-color 0.3s; }
body { font-family: "Vazir", "Segoe UI", Tahoma, sans-serif; background: var(--bg-primary); min-height: 100vh; padding: 12px; direction: rtl; font-size: 13px; color: var(--text-primary); }
.container { max-width: 100%; margin: 0 auto; }
.header { background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%); border-radius: 14px; padding: 14px 20px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; border: 1px solid var(--border-color); }
.header h1 { color: var(--accent-green); font-size: 20px; }
.header .version { font-size: 12px; color: var(--text-muted); background: var(--bg-primary); padding: 4px 12px; border-radius: 20px; }
.theme-switcher { display: flex; gap: 3px; background: var(--bg-primary); padding: 3px; border-radius: 20px; }
.theme-btn { padding: 5px 10px; border: none; border-radius: 16px; cursor: pointer; font-size: 11px; background: transparent; color: var(--text-muted); }
.theme-btn.active { background: var(--accent-green); color: white; }
.stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 10px; }
.stat-card { background: var(--bg-card); border-radius: 10px; padding: 10px 14px; border-right: 3px solid var(--accent-green); cursor: pointer; }
.stat-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
.stat-card .num { font-size: 20px; font-weight: bold; color: var(--accent-green); }
.stat-card .lbl { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
.stat-card.blue { border-right-color: var(--accent-blue); } .stat-card.blue .num { color: var(--accent-blue); }
.stat-card.orange { border-right-color: var(--accent-orange); } .stat-card.orange .num { color: var(--accent-orange); }
.stat-card.red { border-right-color: var(--accent-red); } .stat-card.red .num { color: var(--accent-red); }
.usage-banner { background: linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-secondary) 100%); border-radius: 12px; padding: 14px 18px; margin-bottom: 10px; border: 1px solid var(--border-color); }
.usage-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
.usage-title { color: var(--accent-blue); font-size: 14px; font-weight: 600; }
.usage-numbers { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; }
.usage-numbers b { color: var(--accent-green); }
.usage-bar { width: 100%; height: 8px; background: var(--bg-primary); border-radius: 4px; overflow: hidden; }
.usage-fill { height: 100%; border-radius: 4px; }
.usage-fill.green { background: linear-gradient(90deg, var(--accent-green), #66BB6A); }
.main-grid { display: grid; grid-template-columns: 420px 1fr; gap: 10px; align-items: start; }
@media (max-width: 1100px) { .main-grid { grid-template-columns: 1fr; } }
.sidebar { display: flex; flex-direction: column; gap: 8px; }
.capsule { background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color); overflow: hidden; }
.capsule-header { padding: 11px 14px; background: var(--bg-tertiary); cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none; font-size: 13px; font-weight: 600; color: var(--accent-orange); }
.capsule-header:hover { background: var(--bg-secondary); }
.capsule-header .arrow { transition: transform 0.3s; font-size: 11px; color: var(--text-muted); }
.capsule.open .capsule-header .arrow { transform: rotate(180deg); }
.capsule-body { max-height: 0; overflow: hidden; transition: max-height 0.4s ease, padding 0.3s ease; padding: 0 14px; }
.capsule.open .capsule-body { max-height: 3000px; padding: 10px 14px 14px; }
.input-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.input-row input, .input-row select { flex: 1; min-width: 80px; padding: 7px 10px; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; outline: none; font-family: inherit; }
.input-row input:focus { border-color: var(--accent-green); }
.btn { padding: 7px 14px; border: none; border-radius: 6px; cursor: pointer; color: white; font-size: 12px; font-weight: 500; font-family: inherit; white-space: nowrap; }
.btn:hover { transform: translateY(-1px); opacity: 0.9; }
.btn-primary { background: var(--accent-blue); }
.btn-danger { background: var(--accent-red); }
.btn-success { background: var(--accent-green); }
.btn-warning { background: var(--accent-orange); }
.btn-gray { background: #607D8B; }
.btn-dark { background: #B71C1C; }
.btn-purple { background: var(--accent-purple); }
.btn-cyan { background: var(--accent-cyan); }
.btn-pink { background: var(--accent-pink); }
.btn-xs { padding: 5px 9px; font-size: 12px; }
.result-box { margin-top: 6px; padding: 8px 12px; background: var(--input-bg); border-radius: 6px; display: none; color: var(--text-primary); font-size: 12px; line-height: 1.7; border: 1px solid var(--border-color); max-height: 400px; overflow-y: auto; }
.users-panel { background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); overflow: hidden; }
.users-panel-header { padding: 12px 16px; background: var(--bg-tertiary); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.users-panel-header h2 { color: var(--accent-green); font-size: 15px; }
.filter-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 14px; background: var(--bg-primary); border-bottom: 1px solid var(--border-color); }
.chip { padding: 6px 14px; background: var(--bg-card); border-radius: 18px; font-size: 12px; color: var(--text-secondary); cursor: pointer; border: 1px solid var(--border-color); }
.chip.active { background: var(--accent-green); color: white; border-color: var(--accent-green); }
.chip.active.red { background: var(--accent-red); border-color: var(--accent-red); }
.chip.active.orange { background: var(--accent-orange); border-color: var(--accent-orange); }
.chip.active.purple { background: var(--accent-purple); border-color: var(--accent-purple); }
.chip.active.gray { background: #607D8B; border-color: #607D8B; }
.search-input { padding: 7px 12px; background: var(--input-bg); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; flex: 1; min-width: 150px; outline: none; }
.table-wrapper { overflow-x: auto; max-height: 80vh; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
thead { position: sticky; top: 0; background: var(--bg-tertiary); z-index: 10; }
th { padding: 10px 8px; text-align: right; color: var(--text-muted); font-weight: 600; font-size: 11px; border-bottom: 2px solid var(--border-color); white-space: nowrap; }
td { padding: 8px; border-bottom: 1px solid var(--border-color); color: var(--text-primary); vertical-align: middle; }
tr:hover { background: var(--bg-tertiary); }
tr.force { background: rgba(244,67,54,0.15); }
tr.update { background: rgba(255,152,0,0.1); }
tr.blocked { background: rgba(244,67,54,0.1); opacity: 0.8; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; margin: 1px; white-space: nowrap; }
.badge-green { background: rgba(76,175,80,0.2); color: var(--accent-green); }
.badge-red { background: rgba(244,67,54,0.2); color: var(--accent-red); }
.badge-orange { background: rgba(255,152,0,0.2); color: var(--accent-orange); }
.badge-blue { background: rgba(33,150,243,0.2); color: var(--accent-blue); }
.badge-purple { background: rgba(156,39,176,0.2); color: var(--accent-purple); }
.badge-pink { background: rgba(233,30,99,0.2); color: var(--accent-pink); }
.badge-gray { background: rgba(158,158,158,0.2); color: var(--text-muted); }
.badge-yellow { background: rgba(255,193,7,0.2); color: var(--accent-yellow); }
.action-cell { display: flex; gap: 4px; flex-wrap: wrap; max-width: 220px; }
.footer { text-align: center; color: var(--text-muted); font-size: 11px; margin-top: 12px; padding: 10px; }
.empty { text-align: center; padding: 40px; color: var(--text-muted); }
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 999; display: none; align-items: center; justify-content: center; padding: 20px; }
.modal-overlay.show { display: flex; }
.modal { background: var(--bg-card); border-radius: 16px; padding: 20px; max-width: 700px; width: 100%; border: 1px solid var(--border-color); max-height: 85vh; overflow-y: auto; }
.modal h3 { color: var(--accent-green); margin-bottom: 14px; font-size: 16px; }
.modal-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.info-item { background: var(--bg-primary); padding: 8px 12px; border-radius: 8px; }
.info-item .label { font-size: 10px; color: var(--text-muted); margin-bottom: 2px; }
.info-item .value { font-size: 12px; color: var(--text-primary); font-weight: 500; word-break: break-all; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--bg-card); color: var(--text-primary); padding: 12px 24px; border-radius: 10px; border: 1px solid var(--border-color); box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 9999; opacity: 0; transition: opacity 0.3s; font-size: 13px; }
.toast.show { opacity: 1; }
.help-box { background: var(--input-bg); border-right: 3px solid var(--accent-cyan); padding: 8px 12px; border-radius: 6px; font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.8; }
.message-card { background: var(--bg-primary); border-radius: 10px; padding: 12px; margin: 8px 0; border: 1px solid var(--border-color); border-right: 4px solid var(--accent-pink); }
.message-card.unread { border-right-color: var(--accent-orange); background: rgba(255,152,0,0.08); }
.message-card.read { border-right-color: var(--accent-green); }
.message-card .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px; }
.message-card .phone { font-family: monospace; color: var(--accent-blue); font-weight: 600; font-size: 13px; cursor: pointer; }
.message-card .time { color: var(--text-muted); font-size: 11px; }
.message-card .body { color: var(--text-primary); font-size: 12px; line-height: 1.8; background: var(--bg-secondary); padding: 10px 12px; border-radius: 8px; margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body class="theme-dark">
<div class="container">

<div class="header">
<h1>📍 کجاست؟ <span style="font-size:12px;color:var(--text-muted);font-weight:normal;">پنل مدیریت 8.0</span></h1>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
<div class="theme-switcher">
<button class="theme-btn active" onclick="setTheme('dark', event)">🌙</button>
<button class="theme-btn" onclick="setTheme('light', event)">☀️</button>
<button class="theme-btn" onclick="setTheme('ocean', event)">🌊</button>
<button class="theme-btn" onclick="setTheme('pink', event)">🌸</button>
<button class="theme-btn" onclick="setTheme('forest', event)">🌲</button>
</div>
<span class="version" id="lastUpdate">—</span>
<button class="btn btn-primary btn-xs" onclick="pingServer()">📡 Ping</button>
<button class="btn btn-success btn-xs" onclick="loadData()">🔄 بروزرسانی</button>
</div>
</div>

<div class="help-box">
💡 <b>راهنما:</b> برای دیدن جزئیات هر کاربر روی 📋 کلیک کنید.
</div>

<div class="usage-banner">
<div class="usage-header">
<div class="usage-title">📊 مصرف سرور امروز</div>
<div class="usage-numbers">
<span>مصرف: <b id="usageToday">—</b></span>
<span>باقی‌مانده: <b id="usageRemaining">—</b></span>
</div>
</div>
<div class="usage-bar"><div class="usage-fill green" id="usageFill" style="width:0%"></div></div>
</div>

<div class="stats-bar">
<div class="stat-card" onclick="setFilter('all')"><div class="num" id="statUsers">—</div><div class="lbl">👥 کاربران</div></div>
<div class="stat-card blue" onclick="setFilter('verified')"><div class="num" id="statVerified">—</div><div class="lbl">✅ تأیید</div></div>
<div class="stat-card red" onclick="setFilter('blocked')"><div class="num" id="statBlocked">—</div><div class="lbl">🚫 بلاک</div></div>
<div class="stat-card orange" onclick="setFilter('update')"><div class="num" id="statUpdate">—</div><div class="lbl">🔄 آپدیت</div></div>
<div class="stat-card red" onclick="setFilter('force')"><div class="num" id="statForce">—</div><div class="lbl">⚠️ اجباری</div></div>
</div>

<div class="main-grid">

<div class="sidebar">

<div class="capsule" id="cap-nuke" style="border-color:var(--accent-red);">
<div class="capsule-header" onclick="toggleCapsule('cap-nuke')" style="background:linear-gradient(135deg,#B71C1C,#D32F2F);color:#fff;"><span>💥 ریست کامل سرور</span><span class="arrow">▼</span></div>
<div class="capsule-body">
<input type="text" id="nukeConfirm" class="search-input" placeholder="YES_NUCLEAR_RESET" style="width:100%;margin-bottom:8px;border-color:var(--accent-red);">
<button class="btn btn-dark" onclick="nuclearResetAll()" style="width:100%;padding:12px;font-weight:bold;">💥 پاک‌سازی کامل</button>
<div id="nukeResult" class="result-box"></div>
</div></div>

<div class="capsule" id="cap-msg">
<div class="capsule-header" onclick="toggleCapsule('cap-msg')"><span>📨 ارسال پیام سفارشی</span><span class="arrow">▼</span></div>
<div class="capsule-body">
<div class="input-row">
<input type="text" id="msgPhone" placeholder="شماره...">
<input type="text" id="msgSender" placeholder="فرستنده (اختیاری)">
</div>
<input type="text" id="msgText" class="search-input" placeholder="متن پیام..." style="width:100%;margin-bottom:6px;">
<button class="btn btn-pink" onclick="sendCustomMessage()" style="width:100%;">📨 ارسال پیام</button>
<div id="msgResult" class="result-box"></div>
</div></div>

<div class="capsule" id="cap-version">
<div class="capsule-header" onclick="toggleCapsule('cap-version')"><span>📱 انتشار نسخه جدید</span><span class="arrow">▼</span></div>
<div class="capsule-body">
<div class="input-row">
<input type="text" id="newVersionName" placeholder="نام نسخه" value="1.0.1">
<input type="number" id="newVersionCode" placeholder="کد" value="2">
</div>
<input type="text" id="newDownloadUrl" class="search-input" placeholder="لینک دانلود" style="width:100%;margin-bottom:6px;">
<div class="input-row">
<input type="text" id="newReleaseNotes" placeholder="توضیحات" style="flex:2;">
<input type="text" id="customMessage" placeholder="پیام سفارشی">
</div>
<button class="btn btn-warning" onclick="publishNewVersion()" style="width:100%;">📤 انتشار</button>
<div id="publishResult" class="result-box"></div>
</div></div>

</div>

<div class="users-panel">
<div class="users-panel-header">
<h2>📋 لیست کاربران (<span id="userCount">0</span>)</h2>
<button class="btn btn-success btn-xs" onclick="exportCSV()">📥 CSV</button>
</div>
<div class="filter-row">
<input type="text" id="searchInput" class="search-input" placeholder="🔍 جستجو...">
<div class="chip active" data-filter="all" onclick="setFilter('all')">👥 همه</div>
<div class="chip" data-filter="verified" onclick="setFilter('verified')">✅ تأیید</div>
<div class="chip" data-filter="blocked" onclick="setFilter('blocked')">🚫 بلاک</div>
<div class="chip" data-filter="update" onclick="setFilter('update')">🔄 آپدیت</div>
<div class="chip" data-filter="force" onclick="setFilter('force')">⚠️ اجباری</div>
</div>
<div class="table-wrapper"><table>
<thead><tr>
<th>#</th><th>👤 نام</th><th>📱 شماره</th><th>🎯 هدف</th>
<th>✅ وضعیت</th><th>📊 محدودیت</th><th>📍 موقعیت</th>
<th>🔢 نسخه</th><th>🔧 عملیات</th>
</tr></thead>
<tbody id="usersTableBody"></tbody>
</table></div>
</div>

</div>

<div class="modal-overlay" id="modal-details">
<div class="modal">
<h3>👤 جزئیات کامل کاربر</h3>
<div id="userDetailsContent"></div>
<div class="modal-actions"><button class="btn btn-gray" onclick="closeModal('modal-details')">بستن</button></div>
</div></div>

<div class="toast" id="toast"></div>
<div class="footer">● سرور فعال | پنل 8.0 — Render</div>
</div>

<script>
var SECRET_KEY = "kojaast-admin-key-1403";
var API_BASE = window.location.origin;
var allUsers = [];
var currentFilter = "all";
var searchQuery = "";
var currentTheme = localStorage.getItem("kojaast-theme") || "dark";

function setTheme(theme, ev) {
  document.body.className = "theme-" + theme;
  currentTheme = theme;
  localStorage.setItem("kojaast-theme", theme);
  document.querySelectorAll(".theme-btn").forEach(b => b.classList.remove("active"));
  if (ev && ev.target) ev.target.classList.add("active");
}

function showToast(msg, duration) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), duration || 3000);
}

function toggleCapsule(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle("open");
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll(".chip").forEach(c => {
    if (c.getAttribute("data-filter") === f) {
      c.classList.add("active");
      if (f === "blocked" || f === "force") c.classList.add("red");
      if (f === "update") c.classList.add("orange");
    } else {
      c.classList.remove("active", "red", "orange");
    }
  });
  renderUsers();
}

function closeModal(id) { document.getElementById(id).classList.remove("show"); }

document.getElementById("searchInput").addEventListener("input", function(e) {
  searchQuery = e.target.value.trim().toLowerCase();
  renderUsers();
});

async function loadData() {
  try {
    var res = await fetch(API_BASE + "/api/users?adminKey=" + SECRET_KEY);
    var data = await res.json();
    if (!data.success) { showToast("❌ خطا: " + data.message); return; }
    allUsers = data.users || [];
    document.getElementById("lastUpdate").textContent = "🕐 " + new Date().toLocaleTimeString("fa-IR");
    updateStats(data.stats);
    updateUsage(data.serverUsage);
    renderUsers();
  } catch (e) { showToast("❌ " + e.message); }
}

function updateUsage(usage) {
  if (!usage) return;
  document.getElementById("usageToday").textContent = usage.today.toLocaleString("fa-IR");
  document.getElementById("usageRemaining").textContent = usage.remaining.toLocaleString("fa-IR");
}

function updateStats(stats) {
  var verified = 0, blocked = 0, needsUpd = 0, forceUpd = 0;
  allUsers.forEach(u => {
    if (u.isVerified) verified++;
    if (u.isBlocked) blocked++;
    if (u.needsUpdate) needsUpd++;
    if (u.isForceUpdate) forceUpd++;
  });
  document.getElementById("statUsers").textContent = allUsers.length;
  document.getElementById("statVerified").textContent = verified;
  document.getElementById("statBlocked").textContent = blocked;
  document.getElementById("statUpdate").textContent = needsUpd;
  document.getElementById("statForce").textContent = forceUpd;
  document.getElementById("userCount").textContent = allUsers.length;
}

function renderUsers() {
  var list = allUsers.slice();
  if (currentFilter === "verified") list = list.filter(u => u.isVerified);
  else if (currentFilter === "blocked") list = list.filter(u => u.isBlocked);
  else if (currentFilter === "update") list = list.filter(u => u.needsUpdate);
  else if (currentFilter === "force") list = list.filter(u => u.isForceUpdate);
  
  if (searchQuery) {
    list = list.filter(u => 
      (u.phone && u.phone.indexOf(searchQuery) !== -1) ||
      (u.name && u.name.toLowerCase().indexOf(searchQuery) !== -1)
    );
  }
  
  var tbody = document.getElementById("usersTableBody");
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">❌ کاربری یافت نشد</td></tr>';
    return;
  }
  var html = "";
  for (var i=0; i<list.length; i++) {
    var u = list[i];
    var rowClass = u.isForceUpdate ? "force" : (u.needsUpdate ? "update" : (u.isBlocked ? "blocked" : ""));
    var verifiedBadge = u.isVerified ? '<span class="badge badge-green">✅</span>' : '<span class="badge badge-orange">⏳</span>';
    var blockedBadge = u.isBlocked ? '<span class="badge badge-red">🚫</span>' : "";
    var updateBadge = u.isForceUpdate ? '<span class="badge badge-red">⚠️</span>' :
                      u.needsUpdate ? '<span class="badge badge-orange">🔄</span>' :
                      '<span class="badge badge-green">✅</span>';
    html += '<tr class="' + rowClass + '">';
    html += '<td>' + (i+1) + '</td>';
    html += '<td>' + (u.name || "ناشناس") + '</td>';
    html += '<td style="font-family:monospace;color:var(--accent-blue);">' + u.phone + '</td>';
    html += '<td style="font-family:monospace;font-size:11px;">' + (u.targetPhone || "—") + '</td>';
    html += '<td>' + verifiedBadge + blockedBadge + updateBadge + '</td>';
    html += '<td>' + u.dailySent + '/' + u.dailyLimit + '</td>';
    html += '<td><span class="badge badge-blue">📍 ' + (u.totalLocations || 0) + '</span></td>';
    html += '<td><span class="badge badge-purple">' + (u.appVersion || "—") + '</span></td>';
    html += '<td><div class="action-cell">';
    html += '<button class="btn btn-primary btn-xs" onclick="showUserDetails(\\'' + u.phone + '\\')">📋</button>';
    html += '<button class="btn btn-pink btn-xs" onclick="openMsgModal(\\'' + u.phone + '\\')">📨</button>';
    html += '<button class="btn btn-gray btn-xs" onclick="toggleForce(\\'' + u.phone + '\\')">⚠️</button>';
    html += '<button class="btn btn-success btn-xs" onclick="toggleVerify(\\'' + u.phone + '\\')">' + (u.isVerified ? "❌" : "✅") + '</button>';
    html += '<button class="btn ' + (u.isBlocked ? "btn-success" : "btn-danger") + ' btn-xs" onclick="toggleBlock(\\'' + u.phone + '\\')">' + (u.isBlocked ? "🔓" : "🚫") + '</button>';
    html += '<button class="btn btn-dark btn-xs" onclick="nukeSingle(\\'' + u.phone + '\\')">💥</button>';
    html += '</div></td></tr>';
  }
  tbody.innerHTML = html;
}

window.showUserDetails = async function(phone) {
  document.getElementById("modal-details").classList.add("show");
  document.getElementById("userDetailsContent").innerHTML = "⏳ در حال بارگذاری...";
  try {
    var res = await fetch(API_BASE + "/api/get-user-details?phone=" + encodeURIComponent(phone) + "&adminKey=" + SECRET_KEY);
    var data = await res.json();
    if (!data.success) { document.getElementById("userDetailsContent").innerHTML = "❌ " + data.message; return; }
    var u = data.user;
    var html = '<div class="info-grid">';
    html += '<div class="info-item"><div class="label">👤 نام</div><div class="value">' + (u.name || "—") + '</div></div>';
    html += '<div class="info-item"><div class="label">📱 شماره</div><div class="value">' + u.phone + '</div></div>';
    html += '<div class="info-item"><div class="label">📧 ایمیل</div><div class="value">' + (u.email || "—") + '</div></div>';
    html += '<div class="info-item"><div class="label">🎯 هدف</div><div class="value">' + (u.targetPhone || "—") + '</div></div>';
    html += '<div class="info-item"><div class="label">✅ تأیید</div><div class="value">' + (u.isVerified ? "بله" : "خیر") + '</div></div>';
    html += '<div class="info-item"><div class="label">📅 ثبت‌نام</div><div class="value">' + u.registeredAtFa + '</div></div>';
    html += '<div class="info-item"><div class="label">🕐 آخرین</div><div class="value">' + u.lastSeenFa + '</div></div>';
    html += '<div class="info-item"><div class="label">📍 موقعیت‌ها</div><div class="value">' + u.totalLocations + '</div></div>';
    html += '</div>';
    document.getElementById("userDetailsContent").innerHTML = html;
  } catch (e) { document.getElementById("userDetailsContent").innerHTML = "❌ " + e.message; }
};

window.toggleForce = function(phone) {
  fetch(API_BASE + "/api/toggle-force", { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ phone, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { showToast(result.message); if (result.success) loadData(); });
};

window.toggleVerify = function(phone) {
  fetch(API_BASE + "/api/toggle-verify", { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ phone, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { showToast(result.message); if (result.success) loadData(); });
};

window.toggleBlock = function(phone) {
  var u = allUsers.find(x => x.phone === phone);
  var endpoint = (u && u.isBlocked) ? "/api/unblock-user" : "/api/block-user";
  fetch(API_BASE + endpoint, { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ phone, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { showToast(result.message); if (result.success) loadData(); });
};

window.nukeSingle = function(phone) {
  if (!confirm("💥 تمام اطلاعات " + phone + " پاک می‌شود!")) return;
  fetch(API_BASE + "/api/nuke-user", { 
    method: "DELETE", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ phone, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { 
    if (result.success) { showToast("💥 حذف شد"); loadData(); } 
    else showToast("❌ " + result.message); 
  });
};

window.sendCustomMessage = function() {
  var phone = document.getElementById("msgPhone").value.trim();
  var message = document.getElementById("msgText").value.trim();
  var sender = document.getElementById("msgSender").value.trim() || "مدیریت";
  if (!phone || !message) { alert("⚠️ شماره و پیام الزامی"); return; }
  fetch(API_BASE + "/api/send-custom-message", { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ phone, message, sender, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { 
    document.getElementById("msgResult").style.display = "block";
    document.getElementById("msgResult").textContent = result.message;
    if (result.success) document.getElementById("msgText").value = "";
  });
};

window.openMsgModal = function(phone) {
  document.getElementById("msgPhone").value = phone;
  document.getElementById("cap-msg").classList.add("open");
  document.getElementById("msgText").focus();
};

window.nuclearResetAll = async function() {
  var txt = document.getElementById("nukeConfirm").value.trim();
  if (txt !== "YES_NUCLEAR_RESET") { alert("⚠️ عبارت YES_NUCLEAR_RESET را وارد کنید"); return; }
  if (!confirm("💥💥💥 هشدار! تمام داده‌ها پاک می‌شوند!")) return;
  try {
    var res = await fetch(API_BASE + "/api/nuclear-reset", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey: SECRET_KEY, confirm: "YES_NUCLEAR_RESET" })
    });
    var data = await res.json();
    document.getElementById("nukeResult").style.display = "block";
    document.getElementById("nukeResult").textContent = data.message;
    setTimeout(loadData, 2000);
  } catch (e) { alert("❌ " + e.message); }
};

window.publishNewVersion = function() {
  var name = document.getElementById("newVersionName").value.trim();
  var code = parseInt(document.getElementById("newVersionCode").value);
  var dl = document.getElementById("newDownloadUrl").value.trim();
  var notes = document.getElementById("newReleaseNotes").value.trim();
  var msg = document.getElementById("customMessage").value.trim();
  if (!name || !code) { alert("⚠️ نام و کد الزامی"); return; }
  fetch(API_BASE + "/api/set-app-version", { 
    method: "POST", headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ versionName: name, versionCode: code, downloadUrl: dl, releaseNotes: notes, customMessage: msg, isForAllUsers: true, adminKey: SECRET_KEY }) 
  }).then(r => r.json()).then(result => { 
    document.getElementById("publishResult").style.display = "block";
    document.getElementById("publishResult").textContent = result.message;
  });
};

window.pingServer = async function() {
  var start = Date.now();
  try {
    var res = await fetch(API_BASE + "/api/ping");
    var data = await res.json();
    var ms = Date.now() - start;
    showToast("📡 Pong! " + ms + "ms • نسخه " + data.version);
  } catch (e) { showToast("❌ " + e.message); }
};

window.exportCSV = function() {
  window.open(API_BASE + "/api/export-csv?adminKey=" + SECRET_KEY, "_blank");
};

document.body.className = "theme-" + currentTheme;
loadData();
setInterval(loadData, 30000);
console.log("✅ پنل 8.0 بارگذاری شد");
</script>
</body>
</html>`;
}

// ============================================
// 🚀 شروع سرور
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 سرور کجاست؟ روی پورت ${PORT} اجرا شد`);
    console.log(`📊 دیتابیس: ${DB_FILE}`);
    console.log(`🌐 آدرس: http://localhost:${PORT}`);
});

// ============================================
// 📦 Exit Handler
// ============================================
process.on('SIGINT', () => {
    console.log('💾 ذخیره دیتابیس...');
    saveDb();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('💾 ذخیره دیتابیس...');
    saveDb();
    process.exit(0);
});
