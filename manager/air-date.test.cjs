const {test}=require('node:test');const assert=require('node:assert/strict');
const {normalizeAirDate,airDateLabel,compareAirDates}=require('../js/air-date.cjs');
test('air dates retain precision and reject impossible dates',()=>{
 assert.equal(normalizeAirDate('2024-02-29'),'2024-02-29');assert.equal(normalizeAirDate('2023-02-29'),'');assert.equal(normalizeAirDate('2024-13-01'),'');assert.equal(normalizeAirDate('0000'),'');assert.equal(normalizeAirDate('2024-04'),'2024-04');
});
test('newest sorting compares months and days, then partial dates, with unknowns last',()=>{
 const rows=[{Name:'unknown'},{Name:'year',Year:'2024'},{Name:'April',AirDate:'2024-04-01'},{Name:'October',AirDate:'2024-10-01'},{Name:'October 2',AirDate:'2024-10-02'},{Name:'old',AirDate:'2023-12-31'}];
 assert.deepEqual(rows.sort(compareAirDates).map(r=>r.Name),['October 2','October','April','year','old','unknown']);
});
test('year-only records never present an invented January first',()=>{
 assert.equal(airDateLabel({Year:'2024'}),'开播：2024（具体日期未知）');assert.equal(airDateLabel({Year:'0000'}),'开播日期未知');assert.equal(airDateLabel({AirDate:'2024-04-01',Year:'2024'}),'开播：2024-04-01');
});
