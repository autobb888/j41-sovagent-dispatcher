'use strict';

// One GPU payment holds the machine for the period on THAT listing.
// Minutes are the stored unit. Hours are whole hours only, so 4 hours is
// 240 minutes and never a float. The labour job timeout is a different knob.

const MAX_PERIOD_MIN = 10080; // 7 days
const MAX_HOURS = 168;

function fail(error) {
  return { ok: false, code: 'RENTAL_PERIOD', error };
}

function parseRentalPeriod({ hours, minutes } = {}) {
  const hasHours = hours !== undefined && hours !== null && String(hours).trim() !== '';
  const hasMinutes = minutes !== undefined && minutes !== null && String(minutes).trim() !== '';
  if (hasHours && hasMinutes) {
    return fail('Pass --hours or --minutes, not both.');
  }
  if (!hasHours && !hasMinutes) {
    return fail('Pass --hours (1-168) or --minutes (1-10080). One payment holds the machine for that long.');
  }
  if (hasHours) {
    if (!/^\d+$/.test(String(hours).trim())) return fail('--hours must be a whole number from 1 to 168.');
    const h = Number(String(hours).trim());
    if (h < 1 || h > MAX_HOURS) return fail('--hours must be a whole number from 1 to 168.');
    return { ok: true, minutes: h * 60 };
  }
  if (!/^\d+$/.test(String(minutes).trim())) return fail('--minutes must be a whole number from 1 to 10080.');
  const m = Number(String(minutes).trim());
  if (m < 1 || m > MAX_PERIOD_MIN) return fail('--minutes must be a whole number from 1 to 10080.');
  return { ok: true, minutes: m };
}

function rentalPeriodMinOf(config) {
  const n = Number(config && config.rentalPeriodMin);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIOD_MIN) return null;
  return n;
}

// "4 hours", "1 hour", "45 minutes". Null when the value is not a listing period.
function formatRentalPeriod(minutes) {
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIOD_MIN) return null;
  if (n % 60 === 0) {
    const hours = n / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return n === 1 ? '1 minute' : `${n} minutes`;
}

// The turnaround string rental-setup writes. Free prose ("soon") is not a period.
function periodMinFromTurnaround(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  let m = /^(\d+) hours?$/.exec(s);
  if (m) {
    const hours = Number(m[1]);
    const minutes = hours * 60;
    if (hours >= 1 && minutes <= MAX_PERIOD_MIN) return minutes;
    return null;
  }
  m = /^(\d+) minutes?$/.exec(s);
  if (m) {
    const minutes = Number(m[1]);
    if (minutes >= 1 && minutes <= MAX_PERIOD_MIN) return minutes;
    return null;
  }
  if (/^\d+$/.test(s)) {
    const minutes = Number(s);
    if (minutes >= 1 && minutes <= MAX_PERIOD_MIN) return minutes;
  }
  return null;
}

// An existing gpu-rental row is updated in place. Registering again would
// publish a second card for the same machine.
function planRentalServiceWrite({ services, description, turnaround, price, name, paymentTerms } = {}) {
  const rows = Array.isArray(services) ? services : [];
  const existing = rows.filter((s) => s && s.id && (s.serviceType === 'gpu-rental' || s.service_type === 'gpu-rental'));
  const patch = { description, turnaround };
  if (price !== undefined && price !== null) patch.price = price;
  if (name) patch.name = name;
  if (!existing.length) {
    return {
      action: 'register',
      body: {
        name: name || 'GPU Rental',
        description,
        turnaround,
        price,
        paymentTerms: paymentTerms || 'prepay',
        sovguard: false,
        serviceType: 'gpu-rental',
      },
    };
  }
  return {
    action: 'update',
    updates: existing.map((s) => ({ id: s.id, body: patch })),
  };
}

module.exports = {
  MAX_PERIOD_MIN,
  MAX_HOURS,
  parseRentalPeriod,
  rentalPeriodMinOf,
  formatRentalPeriod,
  periodMinFromTurnaround,
  planRentalServiceWrite,
};
