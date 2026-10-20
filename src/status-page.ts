export const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Home energy check</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { margin-bottom: .25rem; }
    button { font: inherit; padding: .7rem 1rem; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .6; }
    .card { border: 1px solid #8888; border-radius: .7rem; padding: 1rem 1.25rem; margin-top: 1.25rem; }
    dl { display: grid; grid-template-columns: 1fr auto; gap: .4rem 1rem; margin-bottom: 0; }
    dt { color: #777; } dd { margin: 0; text-align: right; font-weight: 600; }
    #message { min-height: 1.5rem; }
  </style>
</head>
<body>
  <h1>Home energy</h1>
  <p>The scheduled check runs every 15 minutes between 08:00 and 22:00 Madrid time. You can request a check at any time. Runs are limited to one at a time, with a 10-minute cooldown shared with the schedule.</p>
  <button id="check" type="button">Check now</button>
  <p id="message" role="status" aria-live="polite">Loading status…</p>
  <section class="card" aria-labelledby="result-heading">
    <h2 id="result-heading">Latest check</h2>
    <dl id="result"><dt>Status</dt><dd>No check recorded yet</dd></dl>
  </section>
  <script>
    const button = document.getElementById('check');
    const message = document.getElementById('message');
    const result = document.getElementById('result');
    const labels = {
      enabled_eco: 'Eco mode enabled at the requested temperature', set_mode_1: 'Heating mode set to 1',
      would_enable_eco: 'Dry run: would enable Eco mode at the requested temperature',
      would_set_mode_1: 'Dry run: would set heating mode to 1',
      already_eco_at_req_temp: 'Water is at or above reqTemp; Eco mode is already on',
      water_at_or_above_req_temp: 'Water is at or above reqTemp; manual mode is not needed',
      outside_manual_mode_hours: 'Outside manual-mode hours (09:00–19:00 Madrid time)',
      net_surplus_at_or_below_500w: 'Net solar surplus is 500 W or lower',
      battery_at_or_below_95pct: 'Battery charge is 95% or lower',
      eco_disabled: 'Eco mode is off', outside_day_hours: 'Outside scheduled daytime hours',
      already_running: 'A check is already running', cooldown: 'Waiting for the 10-minute cooldown'
    };
    function addRow(label, value) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      result.append(dt, dd);
    }
    function localTime(value) { return value ? new Date(value).toLocaleString() : '—'; }
    function render(status) {
      result.replaceChildren();
      const item = status.lastResult;
      if (item) {
        addRow('Time', localTime(item.checkedAt));
        addRow('Started by', item.source === 'manual' ? 'Manual button' : 'Schedule');
        addRow('Outcome', item.outcome.replace('_', ' '));
        addRow('Details', labels[item.reason] || item.reason.replaceAll('_', ' '));
        if (item.generationPower !== undefined) addRow('Solar generation', item.generationPower + ' W');
        if (item.consumptionPower !== undefined) addRow('Home consumption', item.consumptionPower + ' W');
        if (item.netSurplus !== undefined) addRow('Net solar surplus (threshold: > ' + (item.thresholds?.netSurplusAboveW ?? 500) + ' W)', item.netSurplus + ' W');
        if (item.batterySOC !== undefined) addRow('Battery charge', item.batterySOC + '%');
        if (item.temperature !== undefined) addRow('Water temperature', item.temperature + ' °C');
        if (item.reqTemp !== undefined) addRow('Eco threshold (reqTemp)', item.reqTemp + ' C');
        addRow('Manual mode battery threshold', '> ' + (item.thresholds?.batterySOCAbovePercent ?? 95) + '%');
        addRow('Manual mode temperature threshold', 'Below reqTemp (' + item.reqTemp + ' C)');
        addRow('Manual mode hours', (item.thresholds?.manualModeStartHourMadrid ?? 9) + ':00–' + (item.thresholds?.manualModeEndHourMadridExclusive ?? 19) + ':00 Madrid time');
        if (item.eco !== undefined) addRow('Eco mode', item.eco ? 'On' : 'Off');
      } else addRow('Status', 'No check recorded yet');
      if (status.nextAllowedAt) addRow('Next allowed', localTime(status.nextAllowedAt));
      button.disabled = status.running || (status.nextAllowedAt && Date.now() < Date.parse(status.nextAllowedAt));
      message.textContent = status.running ? 'A check is running.' : '';
    }
    async function refresh() {
      try {
        const response = await fetch('/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load status');
        render(await response.json());
      } catch (error) { message.textContent = error.message; }
    }
    button.addEventListener('click', async () => {
      button.disabled = true;
      message.textContent = 'Checking Deye and Ariston…';
      try {
        const response = await fetch('/check', { method: 'POST', cache: 'no-store' });
        const data = await response.json();
        if (data.status) render(data.status);
        if (!response.ok && !data.reason) throw new Error('Could not run the check');
        message.textContent = data.accepted
          ? 'Check finished: ' + (labels[data.result.reason] || data.result.reason.replaceAll('_', ' '))
          : labels[data.reason];
      } catch (error) {
        message.textContent = error.message;
        await refresh();
      }
    });
    refresh();
    setInterval(refresh, 30_000);
  </script>
</body>
</html>`;
