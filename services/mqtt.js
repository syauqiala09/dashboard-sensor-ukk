'use strict';

/**
 * ══════════════════════════════════════════════════════
 *   MQTT SERVICE — HiveMQ Cloud
 *   Protocol : MQTT over Secure WebSocket (WSS)
 *   Broker   : f3f2cdb4048b4168b64821625767251a.s1.eu.hivemq.cloud
 *   Port     : 8884
 * ══════════════════════════════════════════════════════
 */

const MQTT_CFG = {
  brokerUrl: 'wss://f3f2cdb4048b4168b64821625767251a.s1.eu.hivemq.cloud:8884/mqtt',
  username: 'ahmad',
  password: 'Syauqi09',
  clientId: 'web_sensorwatch_' + Math.random().toString(16).slice(2, 10),
  keepalive: 60,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
  topics: {
    sensor: 'smk/iot/sensor',   // subscribe — ESP32 publish sensor data ke sini
    control: 'smk/iot/control',  // publish   — web kirim perintah ke ESP32
  },
};

/**
 * Command strings — harus sama persis dengan callback() di Arduino
 */
const MQTT_CMD = {
  AUTO_ON: 'AUTO_ON',
  AUTO_OFF: 'AUTO_OFF',
  ALL_ON: 'ALL_ON',
  ALL_OFF: 'ALL_OFF',
  /**
   * Generate relay command string
   * @param {1|2|3|4} n  - Nomor relay
   * @param {boolean}  on - true = ON, false = OFF
   * @returns {string}    - misal "R1_ON", "R3_OFF"
   */
  relay: (n, on) => `R${n}_${on ? 'ON' : 'OFF'}`,
};

/**
 * MqttService — singleton wrapper di atas mqtt.js (CDN)
 *
 * Events yang bisa di-listen via .on(event, fn):
 *   'connect'    — koneksi ke broker berhasil
 *   'disconnect' — koneksi putus
 *   'reconnect'  — sedang mencoba reconnect
 *   'error'      — error (arg: Error object)
 *   'sensor'     — data sensor masuk (arg: object JSON yang sudah di-parse)
 *
 * Payload sensor dari ESP32:
 *   { temp: 28.5, humi: 65.0, ldr: 1, mode: "MANUAL", r: [0,1,0,0] }
 *   ldr: 1 = TERANG, 0 = GELAP
 *   r   : array 4 elemen, 1 = ON, 0 = OFF
 */
class MqttService {
  constructor() {
    this.client = null;
    this.connected = false;
    this._listeners = {};
  }

  /* ── Simple event emitter ───────────────────────────── */
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this; // chainable
  }

  _emit(event, ...args) {
    (this._listeners[event] || []).forEach(fn => fn(...args));
  }

  /* ── Connect ke HiveMQ Cloud ────────────────────────── */
  connect() {
    if (typeof mqtt === 'undefined') {
      console.error('[MQTT] mqtt.js tidak ditemukan! Pastikan CDN sudah ditambahkan di index.html');
      this._emit('error', new Error('mqtt.js library not found'));
      return;
    }

    console.log('[MQTT] Menghubungkan ke', MQTT_CFG.brokerUrl);
    this._emit('reconnect');

    this.client = mqtt.connect(MQTT_CFG.brokerUrl, {
      clientId: MQTT_CFG.clientId,
      username: MQTT_CFG.username,
      password: MQTT_CFG.password,
      keepalive: MQTT_CFG.keepalive,
      reconnectPeriod: MQTT_CFG.reconnectPeriod,
      connectTimeout: MQTT_CFG.connectTimeout,
      clean: true,
      protocol: 'wss',
    });

    this.client.on('connect', () => {
      this.connected = true;
      console.log('[MQTT] ✓ Terhubung ke HiveMQ Cloud');
      this.client.subscribe(MQTT_CFG.topics.sensor, { qos: 1 }, (err) => {
        if (err) console.error('[MQTT] Subscribe gagal:', err);
        else console.log('[MQTT] Subscribe ke', MQTT_CFG.topics.sensor);
      });
      this._emit('connect');
    });

    this.client.on('reconnect', () => {
      this.connected = false;
      console.log('[MQTT] Mencoba reconnect…');
      this._emit('reconnect');
    });

    this.client.on('close', () => {
      this.connected = false;
      console.log('[MQTT] Koneksi tertutup');
      this._emit('disconnect');
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
      this._emit('error', err);
    });

    this.client.on('message', (topic, message) => {
      if (topic !== MQTT_CFG.topics.sensor) return;
      const raw = message.toString();
      try {
        const data = JSON.parse(raw);
        console.log('[MQTT] ← RX sensor:', raw);
        this._emit('sensor', data);
      } catch (e) {
        console.warn('[MQTT] Payload bukan JSON valid:', raw);
      }
    });
  }

  /* ── Publish perintah ke ESP32 ──────────────────────── */
  publish(cmd) {
    if (!this.connected || !this.client) {
      console.warn('[MQTT] Belum terhubung — perintah dibatalkan:', cmd);
      return false;
    }
    this.client.publish(MQTT_CFG.topics.control, String(cmd), { qos: 1 });
    console.log('[MQTT] → TX:', cmd);
    return true;
  }

  /* ── Convenience methods ────────────────────────────── */

  /** Kendali relay individual. @param {1|2|3|4} n @param {boolean} on */
  setRelay(n, on) { return this.publish(MQTT_CMD.relay(n, on)); }

  /** Nyalakan semua relay */
  allOn() { return this.publish(MQTT_CMD.ALL_ON); }

  /** Matikan semua relay */
  allOff() { return this.publish(MQTT_CMD.ALL_OFF); }

  /** Set mode AUTO/MANUAL. @param {boolean} isAuto */
  setMode(isAuto) { return this.publish(isAuto ? MQTT_CMD.AUTO_ON : MQTT_CMD.AUTO_OFF); }

  /* ── Disconnect ─────────────────────────────────────── */
  disconnect() {
    if (this.client) {
      this.client.end(true);
      this.connected = false;
    }
  }
}

// Singleton — diakses dari script.js sebagai `mqttService`
const mqttService = new MqttService();
