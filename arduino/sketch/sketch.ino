/**
 * LilyGo T5 4.7" S3 — JPEG Image Fetcher
 *
 * Fetches a JPEG from your Node.js server, decodes it into the EPD
 * framebuffer, renders it, then deep-sleeps.
 * Sends battery percentage as ?battery=XX query parameter.
 * The server replies with headers:
 *   X-Sleep-Seconds — how long to deep-sleep until the next fetch
 *   X-Battery-On    — "1" to switch on the low-battery LED (GPIO 39)
 *
 * Required libraries (Arduino Library Manager):
 *   - LilyGo-EPD47   (Xinyuan-LilyGO/LilyGo-EPD47)
 *   - JPEGDEC        (by Larry Bank)
 *
 * Board settings:
 *   - Board:          LilyGo T5 4.7" S3 (or ESP32S3 Dev Module)
 *   - PSRAM:          OPI PSRAM
 *   - USB CDC On Boot: Enabled
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <JPEGDEC.h>
#include "epd_driver.h"
#include "driver/gpio.h"

// ─── Configuration ────────────────────────────────────────────────────────────

SET_LOOP_TASK_STACK_SIZE(32 * 1024);

static const char*    WIFI_SSID         = "ORBI05";
static const char*    WIFI_PASSWORD     = "huskybreeze611";
static const char*    IMAGE_URL         = "http://10.0.0.103:8083/display.jpg";

static const uint32_t DEFAULT_SLEEP_S   = 2UL * 3600UL;   // fallback if server gives none
static const uint32_t MIN_SLEEP_S       = 60;
static const uint32_t MAX_SLEEP_S       = 24UL * 3600UL;
static const gpio_num_t LED_PIN         = GPIO_NUM_39;
static const uint32_t WIFI_TIMEOUT_MS   = 15000;
static const size_t   FRAME_SIZE        = EPD_WIDTH * EPD_HEIGHT / 2; // 259200

static const float    BATT_VOLTAGE_MAX  = 4.2f;  // 100%
static const float    BATT_VOLTAGE_MIN  = 3.0f;  // 0%

// ─── Globals (needed by the JPEGDEC callback) ─────────────────────────────────

static uint8_t* framebuffer = nullptr;

// ─── Server instructions ──────────────────────────────────────────────────────

static uint32_t sleepSeconds = DEFAULT_SLEEP_S;
static bool     batteryOn    = false;

// ─── Battery ──────────────────────────────────────────────────────────────────

/**
 * Read battery voltage via ADC and return charge percentage (0–100).
 *
 * The T5 4.7" S3 uses a 1:2 resistor divider on the battery line, so the
 * measured voltage is half the actual battery voltage.
 * ADC is 12-bit (0–4095), reference 3.3 V.
 */
int getBatteryPercent() {
    // Average a few readings to reduce ADC noise
    const int SAMPLES = 16;
    long sum = 0;
    for (int i = 0; i < SAMPLES; i++) {
        sum += analogRead(BATT_PIN);
        delay(5);
    }
    float adcValue = (float)(sum / SAMPLES);

    // Convert ADC → actual battery voltage (×2 for the divider)
    float voltage = (adcValue / 4095.0f) * 3.3f * 2.0f;

    Serial.printf("[Batt] ADC: %.0f  Voltage: %.2fV\n", adcValue, voltage);

    // Clamp and map to 0–100
    float pct = (voltage - BATT_VOLTAGE_MIN) / (BATT_VOLTAGE_MAX - BATT_VOLTAGE_MIN) * 100.0f;
    pct = max(0.0f, min(100.0f, pct));

    return (int)pct;
}

// ─── JPEGDEC draw callback ────────────────────────────────────────────────────

int jpegDrawCallback(JPEGDRAW* draw) {
    for (int y = 0; y < draw->iHeight; y++) {
        int imgY = draw->y + y;
        if (imgY >= EPD_HEIGHT) break;

        for (int x = 0; x < draw->iWidth; x++) {
            int imgX = draw->x + x;
            if (imgX >= EPD_WIDTH) break;

            uint16_t pixel = draw->pPixels[y * draw->iWidth + x];

            // Green channel from RGB565 → 4-bit gray
            uint8_t gray4 = ((pixel >> 5) & 0x3F) >> 2;

            int byteIndex = (imgY * EPD_WIDTH + imgX) / 2;
            if (imgX % 2 == 0) {
                framebuffer[byteIndex] = (framebuffer[byteIndex] & 0x0F) | (gray4 << 4);
            } else {
                framebuffer[byteIndex] = (framebuffer[byteIndex] & 0xF0) | gray4;
            }
        }
    }
    return 1;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

bool connectWiFi() {
    Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > WIFI_TIMEOUT_MS) {
            Serial.println("\n[WiFi] Timeout.");
            return false;
        }
        delay(300);
        Serial.print('.');
    }
    Serial.printf("\n[WiFi] Connected: %s\n", WiFi.localIP().toString().c_str());
    return true;
}

bool fetchAndDecode(int batteryPct) {
    // Build URL with battery query parameter
    char url[256];
    snprintf(url, sizeof(url), "%s?battery=%d", IMAGE_URL, batteryPct);

    HTTPClient http;
    http.begin(url);
    http.setTimeout(15000);
    const char* headerKeys[] = { "X-Sleep-Seconds", "X-Battery-On" };
    http.collectHeaders(headerKeys, 2);

    Serial.printf("[HTTP] GET %s\n", url);
    int code = http.GET();
    if (code != HTTP_CODE_OK) {
        Serial.printf("[HTTP] Error: %d\n", code);
        http.end();
        return false;
    }

    if (http.hasHeader("X-Sleep-Seconds")) {
        long s = http.header("X-Sleep-Seconds").toInt();
        if (s > 0) sleepSeconds = constrain((uint32_t)s, MIN_SLEEP_S, MAX_SLEEP_S);
    }
    batteryOn = http.header("X-Battery-On") == "1";
    Serial.printf("[HTTP] Sleep: %u s, battery_on: %d\n", sleepSeconds, batteryOn);

    int contentLen = http.getSize();
    Serial.printf("[HTTP] Content-Length: %d bytes\n", contentLen);

    if (contentLen <= 0 || contentLen > 512 * 1024) {
        Serial.println("[HTTP] Unexpected content length.");
        http.end();
        return false;
    }

    uint8_t* jpegBuf = (uint8_t*) ps_malloc(contentLen);
    if (!jpegBuf) {
        Serial.println("[Error] PSRAM alloc for JPEG failed.");
        http.end();
        return false;
    }

    WiFiClient* stream = http.getStreamPtr();
    size_t received = 0;
    uint32_t timeout = millis();
    while (received < (size_t)contentLen) {
        size_t available = stream->available();
        if (available) {
            received += stream->readBytes(jpegBuf + received, available);
            timeout = millis();
        } else if (millis() - timeout > 5000) {
            break;
        }
        delay(1);
    }
    http.end();

    if (received != (size_t)contentLen) {
        Serial.printf("[HTTP] Incomplete: %u / %d bytes\n", received, contentLen);
        free(jpegBuf);
        return false;
    }
    Serial.println("[HTTP] Download complete.");

    JPEGDEC jpeg;
    if (!jpeg.openRAM(jpegBuf, contentLen, jpegDrawCallback)) {
        Serial.println("[JPEG] Failed to open.");
        free(jpegBuf);
        return false;
    }

    Serial.printf("[JPEG] Image: %d x %d\n", jpeg.getWidth(), jpeg.getHeight());
    memset(framebuffer, 0xFF, FRAME_SIZE);

    int result = jpeg.decode(0, 0, 0);
    jpeg.close();
    free(jpegBuf);

    if (!result) {
        Serial.println("[JPEG] Decode failed.");
        return false;
    }

    Serial.println("[JPEG] Decode OK.");
    return true;
}

void renderImage() {
    Serial.println("[EPD] Rendering...");
    epd_poweron();
    epd_clear();
    Rect_t area = epd_full_screen();
    epd_draw_grayscale_image(area, framebuffer);
    epd_poweroff();
    Serial.println("[EPD] Done.");
}

void setLed(bool on) {
    // Hold the pin level through deep sleep so the LED stays as set until next wake
    gpio_hold_dis(LED_PIN);
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, on ? HIGH : LOW);
    gpio_hold_en(LED_PIN);
    gpio_deep_sleep_hold_en();
    Serial.printf("[LED] %s\n", on ? "ON" : "OFF");
}

void goToSleep() {
    Serial.printf("[Sleep] Sleeping %.2f hours.\n", sleepSeconds / 3600.0);
    Serial.flush();
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    esp_sleep_enable_timer_wakeup((uint64_t)sleepSeconds * 1000000ULL);
    esp_deep_sleep_start();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(2000);
    Serial.println("[Boot] Starting...");

    epd_init();

    framebuffer = (uint8_t*) ps_calloc(FRAME_SIZE, 1);
    if (!framebuffer) {
        Serial.println("[Error] Framebuffer alloc failed.");
        while (true) delay(1000);
    }
    Serial.println("[Mem] Framebuffer allocated.");

    // Read battery before connecting WiFi (cleaner ADC reading without radio noise)
    int battPct = getBatteryPercent();
    Serial.printf("[Batt] %d%%\n", battPct);

    bool ok = false;
    if (connectWiFi()) {
        ok = fetchAndDecode(battPct);
    }

    if (ok) {
        renderImage();
    } else {
        Serial.println("[Warn] Skipping render.");
    }

    free(framebuffer);
    setLed(batteryOn);
    goToSleep();
}

void loop() {}
