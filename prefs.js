import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as PrayTimes from './PrayTimes.js';
import * as Locations from './locations.js';

function log(message) {
    console.log(`Athan Extension: ${message}`);
}

export default class AthanPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings('org.gnome.shell.extensions.athan_custom.sal0-h');
        const settingsUI = new Settings(window._settings);
        const page = new Adw.PreferencesPage();
        page.add(settingsUI.locationGroup);
        page.add(settingsUI.calculationGroup);
        page.add(settingsUI.displayGroup);
        page.add(settingsUI.notificationsGroup);
        window.add(page);

        window.connect('close-request', () => {
            settingsUI.disconnectSignals();
        });
    }
}

class Settings {
    constructor(schema) {
        this.schema = schema;
        this._cityData = [];
        this._signals = [];
        this._httpSession = new Soup.Session();

        log('Initializing settings UI...');
        this.#initFields();
        this.#createView();
        this.#populateCountries();
        this.#bindSettings();

        this.loadCitiesForSavedCountry().catch(e => {
            log(`Failed to load cities in constructor: ${e}`);
        });

        this.#updateLocationFields();
        log('Settings UI Initialized.');
    }

    disconnectSignals() {
        log('Disconnecting signals...');
        for (const [widget, signal] of this._signals) {
            widget.disconnect(signal);
        }
        this._signals = [];
    }

    #initFields() {
        this.field_auto_location_toggle = new Adw.SwitchRow({
            title: _('Automatic location'),
        });
        this.field_time_format_12_toggle = new Adw.SwitchRow({
            title: _('AM/PM time format'),
        });
        this.field_azan_notification_toggle = new Adw.SwitchRow({
            title: _("Notify me when it's athan time"),
        });

        this.field_country = new Adw.ComboRow({
            title: _('Country'),
        });
        this.field_city = new Adw.ComboRow({
            title: _('City'),
        });

        this.field_latitude = new Adw.SpinRow({
            title: _('Latitude'),
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: -90.0,
                upper: 90.0,
                step_increment: 0.0001,
            }),
        });
        this.field_longitude = new Adw.SpinRow({
            title: _('Longitude'),
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: -180.0,
                upper: 180.0,
                step_increment: 0.0001,
            }),
        });
        this.field_hijri_date_adjustment = new Adw.SpinRow({
            title: _('Hijri date adjustment'),
            adjustment: new Gtk.Adjustment({
                lower: -2,
                upper: 2,
                step_increment: 1,
            }),
        });

        this.field_calc_method_mode = new Adw.ComboRow({
            title: _('Calculation method'),
            model: this.#calcMethodOptions(),
        });
        this.field_timezone_mode = new Adw.ComboRow({
            title: _('Timezone'),
            model: this.#timezoneOptions(),
        });
        this.field_panel_position = new Adw.ComboRow({
            title: _('Panel position'),
            model: this.#panelPositionOptions(),
        });
        this.field_which_times_mode = new Adw.ComboRow({
            title: _('Show times'),
            model: this.#whichTimesOptions(),
        });
        this.field_azan_notification_mode = new Adw.ComboRow({
            title: _('Notify me before athan'),
            model: this.#notificationOptions(),
        });
    }

    #createView() {
        this.calculationGroup = new Adw.PreferencesGroup({
            title: _('Calculation'),
        });
        this.calculationGroup.add(this.field_hijri_date_adjustment);
        this.calculationGroup.add(this.field_calc_method_mode);
        this.calculationGroup.add(this.field_timezone_mode);

        this.locationGroup = new Adw.PreferencesGroup({ title: _('Location') });
        this.locationGroup.add(this.field_auto_location_toggle);
        this.locationGroup.add(this.field_country);
        this.locationGroup.add(this.field_city);
        this.locationGroup.add(this.field_latitude);
        this.locationGroup.add(this.field_longitude);

        this.displayGroup = new Adw.PreferencesGroup({ title: _('Display') });
        this.displayGroup.add(this.field_panel_position);
        this.displayGroup.add(this.field_time_format_12_toggle);
        this.displayGroup.add(this.field_which_times_mode);

        this.notificationsGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
        });
        this.notificationsGroup.add(this.field_azan_notification_toggle);
        this.notificationsGroup.add(this.field_azan_notification_mode);
    }

    #bindSettings() {
        const flag = Gio.SettingsBindFlags.DEFAULT;
        this.schema.bind('auto-location', this.field_auto_location_toggle, 'active', flag);
        this.schema.bind('country', this.field_country, 'selected', flag);
        this.schema.bind('city', this.field_city, 'selected', flag);
        this.schema.bind('panel-position', this.field_panel_position, 'selected', flag);
        this.schema.bind('time-format-12', this.field_time_format_12_toggle, 'active', flag);
        this.schema.bind('notify-for-azan', this.field_azan_notification_toggle, 'active', flag);
        this.schema.bind('latitude', this.field_latitude, 'value', flag);
        this.schema.bind('longitude', this.field_longitude, 'value', flag);
        this.schema.bind('hijri-date-adjustment', this.field_hijri_date_adjustment, 'value', flag);
        this.schema.bind('calculation-method', this.field_calc_method_mode, 'selected', flag);
        this.schema.bind('timezone', this.field_timezone_mode, 'selected', flag);
        this.schema.bind('concise-list', this.field_which_times_mode, 'selected', flag);
        this.schema.bind('notify-before-azan', this.field_azan_notification_mode, 'selected', flag);

        this._signals.push([
            this.field_auto_location_toggle,
            this.field_auto_location_toggle.connect('notify::active', () => this.#updateLocationFields())
        ]);
        this._signals.push([
            this.field_country,
            this.field_country.connect('notify::selected', () => {
                this.schema.set_int('city', 0);
                this.loadCitiesForSavedCountry().catch(e => {
                    log(`Failed to load cities on country change: ${e}`);
                });
            })
        ]);
        this._signals.push([
            this.field_city,
            this.field_city.connect('notify::selected', () => this.#updateCoordinates())
        ]);
    }

    #populateCountries() {
        const countries = Locations.countries;
        const list = new Gtk.StringList();
        list.append(_('Select Country'));
        for (const country of countries) {
            list.append(country.name);
        }
        this.field_country.model = list;
    }

    async loadCitiesForSavedCountry() {
        log('Loading cities for saved country...');
        const selectedCountryIndex = this.field_country.selected;
        const list = new Gtk.StringList();
        list.append(_('Loading...'));
        this.field_city.model = list;
        this.field_city.sensitive = false;

        if (selectedCountryIndex <= 0) {
            log('No country selected.');
            list.remove(0);
            list.append(_('Select Country First'));
            this.field_city.model = list;
            return;
        }

        const country = Locations.countries[selectedCountryIndex - 1];
        log(`Fetching cities for country: ${country.code}`);

        const cities = Locations.cities[country.code] || [];
        this._cityData = cities;
        log(`Found ${cities.length} cities.`);

        list.remove(0);
        list.append(_('Select City'));
        if (cities.length > 0) {
            for (const city of cities) {
                list.append(city.name);
            }
            this.field_city.sensitive = true;
        } else {
            list.append(_('No cities found'));
            this.field_city.sensitive = false;
        }
        this.field_city.model = list;

        const savedCityIndex = this.schema.get_int('city');
        log(`Restoring saved city index: ${savedCityIndex}`);
        if (savedCityIndex > 0 && savedCityIndex < list.get_n_items()) {
            this.field_city.selected = savedCityIndex;
        } else {
            this.field_city.selected = 0;
        }
    }

    #updateCoordinates() {
        const selectedCityIndex = this.field_city.selected;
        if (selectedCityIndex <= 0 || !this._cityData || this._cityData.length === 0) {
            return;
        }

        const city = this._cityData[selectedCityIndex - 1];
        if (city) {
            this.schema.set_double('latitude', city.lat);
            this.schema.set_double('longitude', city.lon);
        }
    }

    #calcMethodOptions() {
        const options = PrayTimes.getMethods();
        const list = new Gtk.StringList();
        for (const value of Object.values(options)) {
            list.append(_(value.name));
        }
        return list;
    }

    #timezoneOptions() {
        const options = [
            _('Auto'), _('GMT -12:00'), _('GMT -11:00'), _('GMT -10:00'),
            _('GMT -09:00'), _('GMT -08:00'), _('GMT -07:00'), _('GMT -06:00'),
            _('GMT -05:00'), _('GMT -04:00'), _('GMT -03:00'), _('GMT -02:00'),
            _('GMT -01:00'), _('GMT +00:00'), _('GMT +01:00'), _('GMT +02:00'),
            _('GMT +03:00'), _('GMT +04:00'), _('GMT +05:00'), _('GMT +06:00'),
            _('GMT +07:00'), _('GMT +08:00'), _('GMT +09:00'), _('GMT +10:00'),
            _('GMT +11:00'), _('GMT +12:00'), _('GMT +13:00'), _('GMT +14:00'),
        ];
        const list = new Gtk.StringList();
        for (const option of options) {
            list.append(option);
        }
        return list;
    }

    #panelPositionOptions() {
        const options = [_('Center'), _('Left'), _('Right')];
        const list = new Gtk.StringList();
        for (const option of options) {
            list.append(option);
        }
        return list;
    }

    #whichTimesOptions() {
        const options = [_('Primary prayers only'), _('All times')];
        const list = new Gtk.StringList();
        for (const option of options) {
            list.append(option);
        }
        return list;
    }

    #notificationOptions() {
        const options = [_('Off'), _('5 min'), _('10 min'), _('15 min')];
        const list = new Gtk.StringList();
        for (const option of options) {
            list.append(option);
        }
        return list;
    }

    #updateLocationFields() {
        const autoLocationActive = this.field_auto_location_toggle.active;
        this.field_country.sensitive = !autoLocationActive;
        this.field_city.sensitive = !autoLocationActive;
        this.field_latitude.sensitive = !autoLocationActive;
        this.field_longitude.sensitive = !autoLocationActive;
    }
}