export const compartmentNames = { plastic: 'Plastic bin', metal: 'Metal bin' };

export function compartmentStatus(reading, now = Date.now()) {
  const updated = typeof reading?.updatedAt === 'number'
    ? reading.updatedAt * 1000 : Date.parse(reading?.updatedAt || '');
  const fresh = reading?.readingValid === true && Number.isFinite(updated) && now - updated < 30000;
  const full = reading?.isFull === true;
  return {
    full, fresh,
    label: full ? 'Full — collection required' : fresh ? 'Available' : 'Reading unavailable',
    detail: !fresh ? 'Waiting for a valid sensor reading'
      : Number.isFinite(reading?.distanceCm) ? `${reading.distanceCm} cm from sensor` : 'Sensor connected',
  };
}

export function fullBinDescription(bin) {
  const names = Object.entries(compartmentNames)
    .filter(([key]) => bin.compartments?.[key]?.isFull).map(([, name]) => name);
  return names.length ? `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} full` : 'Bin is full';
}
