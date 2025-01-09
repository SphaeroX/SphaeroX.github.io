//
// carerra4.js
//
"use strict";

/**
 * Einfacher Logger, hier nur als console.log.
 */
export function log(msg) {
    console.log(msg);
}

/**
 * Custom Error-Klassen
 */
export class ProtocolError extends Error { }
export class ChecksumError extends Error { }
export class ConnectionError extends Error { }
export class BufferTooShort extends ConnectionError { }
export class TimeoutError extends ConnectionError { }

/**
 * Checksumme für das Protokoll (wie im Python-Code)
 */
export function chksum(buf, offset = 0, size = null) {
    const n = buf.length;
    if (offset < 0) {
        throw new Error("offset is negative");
    } else if (n < offset) {
        throw new Error("buffer length < offset");
    }
    if (size == null) {
        size = n - offset;
    } else if (size < 0) {
        throw new Error("size is negative");
    } else if (offset + size > n) {
        throw new Error("buffer length < offset + size");
    }

    let sumVal = 0;
    for (let i = offset; i < offset + size; i++) {
        sumVal += buf[i];
    }
    return sumVal & 0x0f;
}

/**
 * Pack-Funktion (vereinfacht)
 */
export function pack(format, ...args) {
    let buf = [];

    function pushByte(byte) {
        buf.push(byte & 0xff);
    }

    let argIndex = 0;
    function nextArg() {
        if (argIndex >= args.length) {
            throw new Error("Insufficient arguments to pack()");
        }
        return args[argIndex++];
    }

    let i = 0;
    while (i < format.length) {
        let c = format[i];
        switch (c) {
            case "c": {
                let value = nextArg();
                if (typeof value === "string") {
                    pushByte(value.charCodeAt(0));
                } else if (value instanceof Uint8Array) {
                    if (value.length !== 1) {
                        throw new Error("'c' format requires a single byte");
                    }
                    pushByte(value[0]);
                } else if (Array.isArray(value)) {
                    if (value.length !== 1) {
                        throw new Error("'c' format requires a single byte array");
                    }
                    pushByte(value[0]);
                } else {
                    pushByte(value & 0xff);
                }
                break;
            }
            case "B": {
                // B => 2 nibbles in ASCII
                let value = nextArg();
                if (value < 0 || value > 0xff) {
                    throw new Error("'B' format argument out of range");
                }
                let base = 48; // '0'
                const loNibble = (value & 0x0f);
                const hiNibble = (value >> 4) & 0x0f;
                pushByte(base + loNibble);
                pushByte(base + hiNibble);
                break;
            }
            case "Y": {
                // Y => 1 nibble in ASCII
                let value = nextArg();
                if (value < 0 || value > 0xf) {
                    throw new Error("'Y' format argument out of range");
                }
                let base = 48; // '0'
                pushByte(base + value);
                break;
            }
            case "r": {
                // 'r' => raw bytes repeated
                // Hier in Kurzform: wir lesen, was als nächstes kommt (count) und dann das Argument
                // (Das volle Parsing wie in Python machen wir hier nicht)
                let sizeStr = "";
                let j = i + 1;
                while (j < format.length && !isNaN(format[j]) && format[j] !== " ") {
                    sizeStr += format[j];
                    j++;
                }
                let count = sizeStr ? parseInt(sizeStr, 10) : 1;
                i = j - 1;

                let value = nextArg();
                if (typeof value === "string") {
                    for (let k = 0; k < value.length; k++) {
                        pushByte(value.charCodeAt(k));
                    }
                } else if (value instanceof Uint8Array) {
                    for (let b of value) {
                        pushByte(b);
                    }
                } else if (Array.isArray(value)) {
                    for (let b of value) {
                        pushByte(b);
                    }
                }
                break;
            }
            case "C": {
                // Checksum
                let offsetVal = 0;
                let csum = chksum(buf, offsetVal, buf.length - offsetVal);
                let base = 48; // '0'
                pushByte(base + csum);
                break;
            }
            default:
                // Überspringen oder ignorieren
                break;
        }
        i++;
    }
    return new Uint8Array(buf);
}

/**
 * Minimale Unpack-Funktion (falls benötigt)
 */
export function unpack(format, buf) {
    let result = [];
    let arr = Array.from(buf);
    let i = 0;
    for (let c of format) {
        switch (c) {
            case "Y": {
                let nib = arr[i] & 0x0f;
                result.push(nib);
                i++;
                break;
            }
            // ...
            default:
                break;
        }
    }
    return result;
}

/**
 * BLE-Verbindung
 */
export class BLEConnection {
    constructor() {
        this._device = null;
        this._server = null;
        this._service = null;
        this._charOutput = null;
        this._charNotify = null;

        this._receiveQueue = [];
        this._notifyCallback = this._notifyCallback.bind(this);

        // UUIDs
        this.SERVICE_UUID = "39df7777-b1b4-b90b-57f1-7144ae4e4a6a".toLowerCase();
        this.CHAR_OUTPUT_UUID = "39df8888-b1b4-b90b-57f1-7144ae4e4a6a".toLowerCase();
        this.CHAR_NOTIFY_UUID = "39df9999-b1b4-b90b-57f1-7144ae4e4a6a".toLowerCase();

        this.max_fwu_block_size = 18;
    }

    async open() {
        // Achtung: Muss https:// sein, damit BLE funktioniert.
        this._device = await navigator.bluetooth.requestDevice({
            filters: [{ name: "Control_Unit" }],
            optionalServices: [this.SERVICE_UUID],
        });
        if (!this._device) throw new Error("Kein Gerät ausgewählt");

        this._device.addEventListener("gattserverdisconnected", () => {
            log("BLE-Device disconnected");
        });

        this._server = await this._device.gatt.connect();
        if (!this._server) {
            throw new Error("GATT Server nicht gefunden");
        }

        this._service = await this._server.getPrimaryService(this.SERVICE_UUID);
        this._charOutput = await this._service.getCharacteristic(this.CHAR_OUTPUT_UUID);
        this._charNotify = await this._service.getCharacteristic(this.CHAR_NOTIFY_UUID);

        await this._charNotify.startNotifications();
        this._charNotify.addEventListener("characteristicvaluechanged", this._notifyCallback);

        log("BLE-Verbindung steht, Notifications gestartet.");
    }

    close() {
        if (this._device && this._device.gatt && this._device.gatt.connected) {
            this._device.gatt.disconnect();
            log("BLE-Device disconnected via close()");
        }
    }

    _notifyCallback(event) {
        const value = event.target.value;
        const buf = new Uint8Array(value.buffer);
        this._receiveQueue.push(buf);
    }

    async recv(maxlength = null, timeoutMs = 1000) {
        const start = performance.now();
        while (this._receiveQueue.length === 0) {
            if (performance.now() - start > timeoutMs) {
                throw new TimeoutError("Timeout beim Warten auf BLE-Antwort");
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        let buf = this._receiveQueue.shift();

        // '$'-Handling wie in ble.py
        if (buf[buf.length - 1] === 0x24) {
            if (buf.length === 6) {
                let newBuf = new Uint8Array(buf.length);
                newBuf[0] = "0".charCodeAt(0);
                newBuf.set(buf.slice(0, -1), 1);
                buf = newBuf.slice(0, buf.length);
            } else {
                let newBuf = new Uint8Array(buf.length);
                newBuf[0] = "?".charCodeAt(0);
                newBuf.set(buf.slice(0, -1), 1);
                buf = newBuf.slice(0, buf.length);
            }
        }

        if (maxlength !== null && buf.length > maxlength) {
            throw new BufferTooShort("Buffer zu kurz");
        }
        return buf;
    }

    async send(buf, offset = 0, size = null) {
        const n = buf.length;
        if (offset < 0) throw new Error("offset negativ");
        if (n < offset) throw new Error("Puffer zu klein");
        if (size == null) {
            size = n - offset;
        } else if (size < 0) {
            throw new Error("size negativ");
        } else if (offset + size > n) {
            throw new Error("buffer length < offset+size");
        }
        const dataToSend = buf.slice(offset, offset + size);
        await this._charOutput.writeValue(dataToSend);
    }
}

/**
 * Funktion, um eine BLE-Verbindung zu öffnen
 */
export async function openConnection() {
    let conn = new BLEConnection();
    await conn.open();
    return conn;
}

/**
 * ControlUnit: Repäsentiert die Carrera CU
 */
export class ControlUnit {
    constructor(connection) {
        this._connection = connection;
    }

    close() {
        this._connection.close();
    }

    async request(buf, maxlength = null) {
        await this._connection.send(buf);
        while (true) {
            const res = await this._connection.recv(maxlength, 2000);
            if (!res || res.length === 0) {
                log("Leere/Unbekannte Antwort empfangen");
                break;
            } else if (res[0] === buf[0]) {
                return res;
            } else {
                log("Unerwartete Nachricht: " + String.fromCharCode(...res));
            }
        }
        return null;
    }

    async version() {
        const msg = new Uint8Array(["0".charCodeAt(0)]);
        const res = await this.request(msg);
        if (res && res.length >= 5) {
            const versionChars = res.slice(1, 5);
            let version = String.fromCharCode(...versionChars);
            return version.trim();
        }
        return null;
    }

    async press(buttonId) {
        // cYC => 'T', buttonId => C
        const msg = pack("cYC", "T".charCodeAt(0), buttonId);
        await this.request(msg);
    }

    async start() {
        await this.press(ControlUnit.START_ENTER_BUTTON_ID);
    }

    async reset() {
        // cYYC => '=', 1, 0 => C
        const msg = pack("cYYC", "=".charCodeAt(0), 1, 0);
        await this.request(msg);
    }

    async poll() {
        const msg = new Uint8Array(["?".charCodeAt(0)]);
        const res = await this.request(msg);
        if (!res) return null;

        // Falls "?:...", dann "status"
        if (res[0] === "?".charCodeAt(0) && res[1] === ":".charCodeAt(0)) {
            let idx = 2;
            let fuel = [];
            for (let i = 0; i < 8; i++) {
                fuel.push(res[idx] & 0x0f);
                idx++;
            }
            let start = res[idx] & 0x0f; idx++;
            let mode = res[idx] & 0x0f; idx++;
            let pitmask = res[idx] & 0x0f; idx++;
            let bLo = res[idx] & 0x0f;
            let bHi = (res[idx + 1] & 0x0f) << 4;
            let display = (bHi | bLo);
            idx += 2;
            return {
                type: "status",
                fuel,
                start,
                mode,
                pitmask,
                display
            };
        } else if (res[0] === "?".charCodeAt(0)) {
            // Timer
            let idx = 1;
            let address = res[idx] & 0x0f;
            idx++;
            if (idx + 7 < res.length) {
                let v0 = (res[idx] & 0x0f) << 24;
                let v1 = (res[idx + 1] & 0x0f) << 28;
                let v2 = (res[idx + 2] & 0x0f) << 16;
                let v3 = (res[idx + 3] & 0x0f) << 20;
                let v4 = (res[idx + 4] & 0x0f) << 8;
                let v5 = (res[idx + 5] & 0x0f) << 12;
                let v6 = (res[idx + 6] & 0x0f) << 0;
                let v7 = (res[idx + 7] & 0x0f) << 4;
                let timestamp = (v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7) >>> 0;
                idx += 8;
                let sector = res[idx] & 0x0f;
                return {
                    type: "timer",
                    address: address - 1,
                    timestamp,
                    sector
                };
            }
        }
        return null;
    }

    async setword(word, address, value, repeat = 1) {
        if (word < 0 || word > 31) throw new Error("Command word out of range");
        if (address < 0 || address > 7) throw new Error("Address out of range");
        if (value < 0 || value > 15) throw new Error("Value out of range");
        if (repeat < 1 || repeat > 15) throw new Error("Repeat count out of range");

        // cBYYC => 'J', word|address<<5, value, repeat => C
        let w = (word | (address << 5)) & 0xff;
        const msg = pack("cBYYC", "J".charCodeAt(0), w, value, repeat);
        await this.request(msg);
    }

    async setspeed(address, value) {
        // word=0
        await this.setword(0, address, value, 2);
    }

    async setbrake(address, value) {
        // word=1
        await this.setword(1, address, value, 2);
    }

    async setfuel(address, value) {
        // word=2
        await this.setword(2, address, value, 2);
    }

    async clrpos() {
        // word=6, value=9
        await this.setword(6, 0, 9);
    }

    async setpos(address, position) {
        if (position < 1 || position > 8) {
            throw new Error("Position out of range");
        }
        await this.setword(6, address, position);
    }

    async setlap(value) {
        if (value < 0 || value > 255) throw new Error("Lap value out of range");
        await this.setlap_hi(value >> 4);
        await this.setlap_lo(value & 0xf);
    }
    async setlap_hi(value) {
        await this.setword(17, 7, value);
    }
    async setlap_lo(value) {
        await this.setword(18, 7, value);
    }

    async fwu_start() {
        // ccC => 'G','B' => C
        const msg = pack("ccC", "G".charCodeAt(0), "B".charCodeAt(0));
        await this.request(msg);
    }
    async fwu_write(data) {
        if (!this._connection.max_fwu_block_size) {
            const msg = pack(`c${data.length}sC`, "E".charCodeAt(0), data);
            await this.request(msg);
        } else {
            let n = this._connection.max_fwu_block_size;
            for (let i = 0; i < data.length; i += n) {
                let block = data.slice(i, i + n);
                const msg = pack(`cr${block.length}s`, "F".charCodeAt(0), block.length, block);
                await this.request(msg);
            }
            const msg2 = pack("cC", "E".charCodeAt(0));
            await this.request(msg2);
        }
    }
}

ControlUnit.PACE_CAR_ESC_BUTTON_ID = 1;
ControlUnit.START_ENTER_BUTTON_ID = 2;
ControlUnit.SPEED_BUTTON_ID = 5;
ControlUnit.BRAKE_BUTTON_ID = 6;
ControlUnit.FUEL_BUTTON_ID = 7;
ControlUnit.CODE_BUTTON_ID = 8;

/**
 * Driver-Klasse
 */
export class Driver {
    constructor(num) {
        this.num = num;
        this.time = null;
        this.laptime = null;
        this.bestlap = null;
        this.laps = 0;
        this.pits = 0;
        this.fuel = 0;
        this.pit = false;

        // Zusatz für Sektor-Logik
        this.sectorStart = null;
        this.sector1Time = 0;
        this.sector2Time = null;
        this.sector3Time = null;
        this.bestSector2Time = null;
        this.bestSector3Time = null;

        // Für Sparklines
        this.lapHistory = [];
    }

    newLap(timerTimestamp) {
        if (this.time !== null) {
            this.laptime = timerTimestamp - this.time;
            if (this.bestlap === null || this.laptime < this.bestlap) {
                this.bestlap = this.laptime;
            }
            this.laps++;
            // Für Sparklines speichern wir mal pauschal die laptime
            this.lapHistory.push(this.laptime);
        }
        this.time = timerTimestamp;
    }
}

/**
 * Hilfsfunktion: Millisekunden -> String
 */
export function msToString(ms) {
    if (ms === null || ms === undefined) return "n/a";
    let s = Math.floor(ms / 1000);
    let milli = ms % 1000;
    if (s < 60) {
        return `${s}.${milli.toString().padStart(3, '0')}s`;
    }
    let mins = Math.floor(s / 60);
    let secs = s % 60;
    return `${mins}m${secs}.${milli.toString().padStart(3, '0')}s`;
}

/**
 * RaceManager
 */
export class RaceManager {
    constructor(cu) {
        this.cu = cu;
        this.drivers = [];
        for (let i = 1; i <= 8; i++) {
            this.drivers.push(new Driver(i));
        }
        this.start = null;
        this.maxlaps = 0;
        this.lapTimes = [];
        this.sectorTimes = [];
    }

    async resetAll() {
        this.drivers.forEach(d => {
            d.time = null;
            d.laptime = null;
            d.bestlap = null;
            d.laps = 0;
            d.pits = 0;
            d.fuel = 0;
            d.pit = false;
            d.sectorStart = null;
            d.sector1Time = 0;
            d.sector2Time = null;
            d.sector3Time = null;
            d.bestSector2Time = null;
            d.bestSector3Time = null;
            d.lapHistory = [];
        });
        this.start = null;
        this.maxlaps = 0;
        this.lapTimes = [];
        this.sectorTimes = [];

        let status = null;
        do {
            status = await this.cu.poll();
        } while (status && status.type !== "status");

        await this.cu.reset();
        await this.cu.clrpos();
    }

    handleStatus(status) {
        for (let i = 0; i < 8; i++) {
            const d = this.drivers[i];
            d.fuel = status.fuel[i];
            let pit = !!((status.pitmask >> i) & 1);
            if (pit && !d.pit) {
                d.pits++;
            }
            d.pit = pit;
        }
    }

    async handleTimer(timer) {
        const d = this.drivers[timer.address];
        if (!d) return;

        if (!d.sectorStart) {
            d.sectorStart = timer.timestamp;
        }
        const sectorTime = timer.timestamp - d.sectorStart;
        d.sectorStart = timer.timestamp;

        if (timer.sector === 1) {
            // Start/Ziel => neue Runde
            if (d.sector2Time != null && d.sector3Time != null) {
                d.laptime = d.sector1Time + d.sector2Time + d.sector3Time;
            } else {
                d.laptime = sectorTime;
            }
            this.lapTimes.push(d.laptime);
            d.newLap(timer.timestamp);

            d.sector1Time = 0;
            d.sector2Time = null;
            d.sector3Time = null;
        }
        else if (timer.sector === 2) {
            d.sector2Time = sectorTime;
            if (!d.bestSector2Time || sectorTime < d.bestSector2Time) {
                d.bestSector2Time = sectorTime;
            }
        }
        else if (timer.sector === 3) {
            d.sector3Time = sectorTime;
            if (!d.bestSector3Time || sectorTime < d.bestSector3Time) {
                d.bestSector3Time = sectorTime;
            }
        }
        this.sectorTimes.push(sectorTime);

        if (this.maxlaps < d.laps) {
            this.maxlaps = d.laps;
            await this.cu.setlap(this.maxlaps % 250);
        }
    }

    getTop5Laps() {
        let sorted = this.lapTimes.filter(x => x !== null).sort((a, b) => a - b);
        return sorted.slice(0, 5);
    }

    getTop5Sectors() {
        let sorted = this.sectorTimes.filter(x => x !== null).sort((a, b) => a - b);
        return sorted.slice(0, 5);
    }

    getSortedDrivers() {
        let driversWithTime = this.drivers.filter(d => d.time !== null);
        driversWithTime.sort((a, b) => {
            if (b.laps !== a.laps) return b.laps - a.laps;
            return a.time - b.time;
        });
        return driversWithTime;
    }
}
