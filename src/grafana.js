import { config } from "./config.js";

const sendGrafanaSilence = async (alert, start, end = new Date(0)) => {
    

    if (!config.GRAFANA_URL || !config.GRAFANA_API_KEY) {
        console.error('Grafana config missing, cannot silence');
        return false;
    }

    if (end < start) {
        // If end is before start (or default 0), set it to 24h from start
        end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    } else if (typeof end === 'number') {
        end = new Date(end);
    }

    const matchers = Object.entries(alert.labels).map(([name, value]) => ({
        name,
        value,
        isRegex: false,
        isEqual: true
    }));

    const payload = {
        matchers,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        createdBy: "Grafana2Matrix",
        comment: `Silenced via Matrix for 24h`
    };
    

    try {
        const response = await fetch(`${config.GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Authorization': `Bearer ${config.GRAFANA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Grafana response:', errorData);
            return false;
        }
        return true;
    } catch (error) {
        console.error('Failed to create silence:', error.message);
    }
    
}

const fetchGrafanaSilences = async () => {
    if (!config.GRAFANA_URL || !config.GRAFANA_API_KEY) {
        console.error('Grafana config missing, cannot fetch silences');
        return [];
    }

    try {
        const response = await fetch(`${config.GRAFANA_URL}/api/alertmanager/grafana/api/v2/silences?filter=state%3Dactive`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${config.GRAFANA_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('Grafana response:', errorData);
            return [];
        }

        const data = await response.json();
        return data; // Returns array of silences
    } catch (error) {
        console.error('Failed to fetch silences:', error.message);
        return [];
    }
}

export { sendGrafanaSilence, fetchGrafanaSilences };