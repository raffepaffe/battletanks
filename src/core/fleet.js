/**
 * The fleet: five units of real tanks from the first half of the 20th century.
 * A unit is a column of identical tanks, one per cell. Unit sizes loosely follow
 * how many of each tank were built: T-34s and Shermans by the tens of thousands,
 * Tigers by the hundred.
 *
 * Unit ids go over the sound link, so the order here is part of the protocol.
 */
export const FLEET = Object.freeze([
  Object.freeze({ id: 0, key: 't34', name: 'T-34', unit: 'column', nation: 'Soviet Union', year: 1940, length: 5 }),
  Object.freeze({ id: 1, key: 'sherman', name: 'M4 Sherman', unit: 'company', nation: 'United States', year: 1942, length: 4 }),
  Object.freeze({ id: 2, key: 'churchill', name: 'Churchill', unit: 'troop', nation: 'United Kingdom', year: 1941, length: 3 }),
  Object.freeze({ id: 3, key: 'tiger', name: 'Tiger I', unit: 'platoon', nation: 'Germany', year: 1942, length: 3 }),
  Object.freeze({ id: 4, key: 'ft', name: 'Renault FT', unit: 'section', nation: 'France', year: 1917, length: 2 }),
]);

export const FLEET_CELLS = FLEET.reduce((sum, u) => sum + u.length, 0);

export const isUnitId = (id) => Number.isInteger(id) && id >= 0 && id < FLEET.length;
