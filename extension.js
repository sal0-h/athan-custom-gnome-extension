import Geoclue from 'gi://Geoclue';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {
    Extension,
    gettext as _,
    ngettext,
    pgettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PermissionStore from 'resource:///org/gnome/shell/misc/permissionStore.js';
import * as PrayTimes from './PrayTimes.js';
import * as HijriCalendarKuwaiti from './HijriCalendarKuwaiti.js';

// Constants
const HALF_DAY_SECONDS = 12 * 3600;
const FULL_DAY_SECONDS = 24 * 3600;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MINUTES_PER_HOUR = 60;
const VALID_LATITUDE_MIN = -90;
const VALID_LATITUDE_MAX = 90;
const VALID_LONGITUDE_MIN = -180;
const VALID_LONGITUDE_MAX = 180;

const Azan = GObject.registerClass(
    class Azan extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, _('Azan'));

            this.logger = extension.getLogger();

            this._azanNotified = false;
            this._beforeAzanNotified = false;
            this._lastNotifiedPrayerId = null;

            this.extension = extension;

            this._settings = extension.getSettings(
                'org.gnome.shell.extensions.athan_custom.sal0-h'
            );
            this._panelPositionArr = ['center', 'left', 'right'];
            this._notifyBeforeAzanMinutes = [0, 5, 10, 15]; // ? Mapping to minutes
            this._conciseListLevels = [0, 1]; // ? 0: Primary prayers only, 1: All times
            
            // Initialize Geoclue service to null
            this._gclueService = null;
            this._gclueStarting = false;

            this._bindSettings();
            this._loadSettings();

            this._initTimeData();
            this._initUI();
            this._initServices();

            this._updateLabelPeriodic();
            this._updatePrayerVisibility();
        }

        _initTimeData() {
            this._dateFormatFull = _('%A %B %e, %Y');

            this._prayTimes = new PrayTimes.PrayTimes('MWL');

            this._dayNames = [
                _('Al-Ahad'),
                _('Al-Ithnain'),
                _("Al-Thulatha'"),
                _("Al-Arbi'a'"),
                _('Al-Khamees'),
                _("Al-Jumu'ah"),
                _('Al-Ssabt'),
            ];
            this._monthNames = [
                _('Muharram'),
                _('Safar'),
                _("Rabi' Al-Awwal"),
                _("Rabi' Al-Aakhir"),
                _('Jumada Al-Uola'),
                _('Jumada Al-Aakhirah'),
                _('Rajab'),
                _("Sha'ban"),
                _('Ramadan'),
                _('Shawwal'),
                _("Thu Al-Qa'dah"),
                _('Thu Al-Hijjah'),
            ];

            let today = new Date();
            let dayOfWeek = today.getDay();
            this._timeNames = {
                fajr: _('Al-Fajr'),
                sunrise: _('Al-Shurooq'),
                dhuhr: dayOfWeek === 5 ? _('Jummah') : _('Al-Thuhr'),
                asr: _('Al-Asr'),
                maghrib: _('Al-Maghrib'),
                isha: _("Al-Isha'"),
                midnight: _('Muntasaf Al-Layl'),
            };

            this._primaryPrayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

            this._timeConciseLevels = {
                fajr: 0,
                sunrise: 1,
                dhuhr: 0,
                asr: 0,
                maghrib: 0,
                isha: 0,
                midnight: 1,
            };

            this._calcMethodsArr = ['MWL', 'Makkah', 'Egypt', 'Karachi', 'Qatar'];
            this._calcMethodNames = [
                _('Muslim World League'),
                _('Umm Al-Qura University, Makkah'),
                _('Egyptian General Authority of Survey, Egypt'),
                _('University of Islamic Sciences, Karachi'),
                _('Qatar'),
            ];
            this._timezoneArr = Array.from({ length: 27 }, (_, index) =>
                (index - 12).toString()
            );
            this._timezoneArr.unshift('auto');
        }

        _initServices() {
            this._gclueLocationChangedId = 0;
            this._weatherAuthorized = false;
            this._gclueService = null;
            this._gclueStarting = false;

            this._permStore = new PermissionStore.PermissionStore(
                (proxy, error) => {
                    if (error) {
                        this.logger.log(
                            'Failed to connect to permissionStore: ' +
                                error.message
                        );
                        return;
                    }

                    this._permStore.LookupRemote(
                        'gnome',
                        'geolocation',
                        (res, error) => {
                            if (error) {
                                this.logger.log(
                                    'Error looking up permission: ' +
                                        error.message
                                );
                            }

                            let [perms, data] = error ? [{}, null] : res;
                            let params = [
                                'gnome',
                                'geolocation',
                                false,
                                data,
                                perms,
                            ];
                            this._onPermStoreChanged(
                                this._permStore,
                                '',
                                params
                            );
                        }
                    );
                }
            );
        }

        _initUI() {
            Main.panel.addToStatusArea(
                'athan_custom@sal0-h',
                this,
                1,
                this._panelPosition
            );

            this.indicatorText = new St.Label({
                text: _('...'),
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this.indicatorText);

            this._prayItems = {};

            this._dateMenuItem = new PopupMenu.PopupMenuItem(_('...'), {
                style_class: 'athan-panel',
                reactive: false,
                hover: false,
                activate: false,
            });

            this.menu.addMenuItem(this._dateMenuItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (let prayerId in this._timeNames) {
                let prayerName = this._timeNames[prayerId];

                let prayMenuItem = new PopupMenu.PopupMenuItem(_(prayerName), {
                    reactive: false,
                    hover: false,
                    activate: false,
                });

                let bin = new St.Bin({
                    x_expand: true,
                    x_align: Clutter.ActorAlign.END,
                });

                let prayLabel = new St.Label({
                    text: _('...'),
                    style_class: 'athan-label',
                });
                bin.add_child(prayLabel);

                prayMenuItem.actor.add_child(bin);

                this.menu.addMenuItem(prayMenuItem);

                this._prayItems[prayerId] = {
                    menuItem: prayMenuItem,
                    label: prayLabel,
                };
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.prefs_s = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            let l = new St.Label({ text: ' ' });
            l.x_expand = true;
            this.prefs_s.actor.add_child(l);
            this.prefs_b = new St.Button({
                child: new St.Icon({
                    icon_name: 'preferences-system-symbolic',
                    icon_size: 30,
                }),
                style_class: 'prefs_s_action',
            });

            this.prefs_b.connect('clicked', () => {
                this.extension.openPreferences();
            });

            this.prefs_s.actor.add_child(this.prefs_b);
            l = new St.Label({ text: ' ' });
            l.x_expand = true;
            this.prefs_s.actor.add_child(l);

            this.menu.addMenuItem(this.prefs_s);
        }

        _bindSettings() {
            this._settingsChangedIds = [];

            const connectSetting = (key, handler) => {
                const id = this._settings.connect(
                    `changed::${key}`,
                    (settings) => {
                        this._loadSettings();
                        handler();
                    }
                );
                this._settingsChangedIds.push(id);
            };

            connectSetting('auto-location', () => {
                this._updateAutoLocation();
                this._updateLabel();
            });

            connectSetting('calculation-method', this._updateLabel.bind(this));
            connectSetting('latitude', this._updateLabel.bind(this));
            connectSetting('longitude', this._updateLabel.bind(this));
            connectSetting('country', this._updateLabel.bind(this));
            connectSetting('city', this._updateLabel.bind(this));
            connectSetting('time-format-12', this._updateLabel.bind(this));
            connectSetting('timezone', this._updateLabel.bind(this));
            connectSetting('concise-list', () => {
                this._updateLabel();
                this._updatePrayerVisibility();
            });
            connectSetting('hijri-date-adjustment', this._updateLabel.bind(this));
            connectSetting('notify-for-azan', this._updateLabel.bind(this));
            connectSetting('notify-before-azan', this._updateLabel.bind(this));
            connectSetting('panel-position', () => {
                this.extension._updateAzan();
            });
        }

        _loadSettings() {
            const settingsKeys = {
                'auto-location': 'boolean',
                'calculation-method': 'int',
                latitude: 'double',
                longitude: 'double',
                'time-format-12': 'boolean',
                timezone: 'int',
                'concise-list': 'int',
                'hijri-date-adjustment': 'int',
                'notify-for-azan': 'boolean',
                'notify-before-azan': 'int',
                'panel-position': 'int',
                country: 'string',
                city: 'string',
            };

            for (const key in settingsKeys) {
                const type = settingsKeys[key];
                const getMethod = `get_${type}`;
                const optKey = `_opt_${key.replace(/-/g, '_')}`;
                this[optKey] = this._settings[getMethod](key);
            }

            this._opt_notify_before_azan =
                this._notifyBeforeAzanMinutes[this._opt_notify_before_azan];

            this._opt_concise_list =
                this._conciseListLevels[this._opt_concise_list];

            this._panelPosition =
                this._panelPositionArr[this._opt_panel_position];

            this._updateAutoLocation();
        }

        _startGClueService() {
            if (this._gclueStarting) return;

            this._gclueStarting = true;

            Geoclue.Simple.new(
                'org.gnome.Shell',
                Geoclue.AccuracyLevel.EXACT,
                null,
                (o, res) => {
                    try {
                        this._gclueService = Geoclue.Simple.new_finish(res);
                        if (this._gclueService && this._gclueService.get_client) {
                            this._gclueService.get_client().distance_threshold = 100;
                        }
                        this._updateLocationMonitoring();
                    } catch (e) {
                        this.logger.log(
                            'Failed to connect to Geoclue2 service: ' +
                                e.message
                        );
                        this._gclueService = null;
                    } finally {
                        this._gclueStarting = false;
                    }
                }
            );
        }

        _onPermStoreChanged(proxy, sender, params) {
            let [
                table,
                id,
                ,
                ,
                perms,
            ] = params;

            if (table != 'gnome' || id != 'geolocation') return;

            let permission = perms['org.gnome.Weather.Application'] || ['NONE'];
            let [accuracy] = permission;
            this._weatherAuthorized = accuracy != 'NONE';

            this._updateAutoLocation();
        }

        _onGClueLocationChanged() {
            if (!this._gclueService) {
                this.logger.log('Geoclue service not available');
                return;
            }

            try {
                const geoLocation = this._gclueService.location;
                if (!geoLocation) {
                    this.logger.log('Geoclue location not available');
                    return;
                }

                const latitude = geoLocation.latitude;
                const longitude = geoLocation.longitude;

                // Validate coordinates
                if (this._isValidCoordinate(latitude, longitude)) {
                    this._opt_latitude = latitude;
                    this._opt_longitude = longitude;
                    this._settings.set_double('latitude', this._opt_latitude);
                    this._settings.set_double('longitude', this._opt_longitude);
                } else {
                    this.logger.log(
                        `Invalid coordinates received: lat=${latitude}, lon=${longitude}`
                    );
                }
            } catch (e) {
                this.logger.log('Error accessing Geoclue location: ' + e.message);
            }
        }

        _isValidCoordinate(lat, lon) {
            return (
                typeof lat === 'number' &&
                typeof lon === 'number' &&
                !isNaN(lat) &&
                !isNaN(lon) &&
                isFinite(lat) &&
                isFinite(lon) &&
                lat >= VALID_LATITUDE_MIN &&
                lat <= VALID_LATITUDE_MAX &&
                lon >= VALID_LONGITUDE_MIN &&
                lon <= VALID_LONGITUDE_MAX
            );
        }

        _updateLocationMonitoring() {
            if (this._opt_auto_location) {
                if (
                    this._gclueLocationChangedId != 0 ||
                    this._gclueService == null
                )
                    return;

                try {
                    this._gclueLocationChangedId = this._gclueService.connect(
                        'notify::location',
                        this._onGClueLocationChanged.bind(this)
                    );
                    this._onGClueLocationChanged();
                } catch (e) {
                    this.logger.log(
                        'Error connecting to location monitoring: ' + e.message
                    );
                    this._gclueLocationChangedId = 0;
                }
            } else {
                if (this._gclueLocationChangedId && this._gclueService) {
                    try {
                        this._gclueService.disconnect(this._gclueLocationChangedId);
                    } catch (e) {
                        this.logger.log(
                            'Error disconnecting location monitoring: ' + e.message
                        );
                    }
                }
                this._gclueLocationChangedId = 0;
            }
        }

        _updateAutoLocation() {
            this._updateLocationMonitoring();

            if (this._opt_auto_location) {
                this._startGClueService();
            }
        }

        _updatePrayerVisibility() {
            for (let prayerId in this._timeNames) {
                this._prayItems[prayerId].menuItem.actor.visible =
                    this._isVisiblePrayer(prayerId);
            }
        }

        _isVisiblePrayer(prayerId) {
            return this._timeConciseLevels[prayerId] <= this._opt_concise_list;
        }

        _updateLabelPeriodic() {
            if (this._periodicTimeoutId) {
                GLib.source_remove(this._periodicTimeoutId);
            }

            this._periodicTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                1,
                () => {
                    this._updateLabel();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        _updateLabel() {
            try {
                // Validate coordinates before calculating prayer times
                if (!this._isValidCoordinate(this._opt_latitude, this._opt_longitude)) {
                    this.logger.log(
                        `Invalid coordinates: lat=${this._opt_latitude}, lon=${this._opt_longitude}`
                    );
                    this.indicatorText.set_text(_('Invalid location'));
                    return;
                }

                const currentDate = new Date();
                const currentSeconds = this._calculateSecondsFromDate(currentDate);

                const timesStr = this._getPrayerTimes(currentDate, 'String');
                const timesFloat = this._getPrayerTimes(currentDate, 'Float');

                // Validate prayer times were calculated successfully
                if (!timesStr || !timesFloat) {
                    this.logger.log('Failed to calculate prayer times');
                    this.indicatorText.set_text(_('Error calculating times'));
                    return;
                }

                for (const prayerId in this._timeNames) {
                    if (this._prayItems[prayerId] && this._prayItems[prayerId].label) {
                        this._prayItems[prayerId].label.text = timesStr[prayerId] || '-----';
                    }
                }

                const {
                    nextPrayer,
                    previousPrayer,
                    isTimeForPraying,
                } = this._findNearestPrayer(timesFloat, currentSeconds);

                if (!nextPrayer || !previousPrayer) {
                    this.logger.log('Failed to find nearest prayers');
                    return;
                }

                if (nextPrayer.id !== this._lastNotifiedPrayerId) {
                    this._azanNotified = false;
                    this._beforeAzanNotified = false;
                    this._lastNotifiedPrayerId = nextPrayer.id;
                }

                this._updatePrayerHighlight(nextPrayer.id, previousPrayer.id);
                this._updateIslamicDate();
                this._handlePrayerNotifications(
                    nextPrayer,
                    previousPrayer,
                    timesStr,
                    isTimeForPraying
                );
                this._updateIndicatorText(
                    isTimeForPraying,
                    nextPrayer,
                    previousPrayer
                );
            } catch (e) {
                this.logger.log('Error updating label: ' + e.message);
                this.indicatorText.set_text(_('Error'));
            }
        }

        _getPrayerTimes(currentDate, format) {
            try {
                // Validate calculation method index
                const calcMethodIndex = this._opt_calculation_method || 0;
                if (calcMethodIndex < 0 || calcMethodIndex >= this._calcMethodsArr.length) {
                    this.logger.log(`Invalid calculation method index: ${calcMethodIndex}`);
                    return null;
                }

                // Validate timezone index
                const timezoneIndex = this._opt_timezone || 0;
                if (timezoneIndex < 0 || timezoneIndex >= this._timezoneArr.length) {
                    this.logger.log(`Invalid timezone index: ${timezoneIndex}`);
                    return null;
                }

                const myLocation = [this._opt_latitude, this._opt_longitude];
                const myTimezone = this._timezoneArr[timezoneIndex];

                this._prayTimes.setMethod(
                    this._calcMethodsArr[calcMethodIndex]
                );
                this._prayTimes.adjust({ asr: 'Standard' });

                return this._opt_time_format_12
                    ? this._prayTimes.getTimes(
                          currentDate,
                          myLocation,
                          myTimezone,
                          'auto',
                          format === 'String' ? '12h' : 'Float'
                      )
                    : this._prayTimes.getTimes(
                          currentDate,
                          myLocation,
                          myTimezone,
                          'auto',
                          format === 'String' ? '24h' : 'Float'
                      );
            } catch (e) {
                this.logger.log('Error getting prayer times: ' + e.message);
                return null;
            }
        }

        _findNearestPrayer(timesFloat, currentSeconds) {
            if (!timesFloat || typeof currentSeconds !== 'number' || isNaN(currentSeconds)) {
                return { nextPrayer: null, previousPrayer: null, isTimeForPraying: false };
            }

            let prayerTimes = this._primaryPrayers.map(prayerId => {
                const prayerSeconds = this._calculatePrayerSeconds(
                    timesFloat,
                    prayerId
                );
                
                if (typeof prayerSeconds !== 'number' || isNaN(prayerSeconds)) {
                    return null;
                }

                let diffSeconds = prayerSeconds - currentSeconds;

                // Handle wraparound at midnight
                if (diffSeconds < -HALF_DAY_SECONDS) {
                    diffSeconds += FULL_DAY_SECONDS;
                } else if (diffSeconds > HALF_DAY_SECONDS) {
                    diffSeconds -= FULL_DAY_SECONDS;
                }

                return {
                    id: prayerId,
                    diffMinutes: Math.floor(diffSeconds / SECONDS_PER_MINUTE),
                };
            }).filter(p => p !== null);

            if (prayerTimes.length === 0) {
                return { nextPrayer: null, previousPrayer: null, isTimeForPraying: false };
            }

            let nextPrayer = prayerTimes
                .filter(p => p.diffMinutes > 0)
                .sort((a, b) => a.diffMinutes - b.diffMinutes)[0];

            let previousPrayer = prayerTimes
                .filter(p => p.diffMinutes <= 0)
                .sort((a, b) => b.diffMinutes - a.diffMinutes)[0];

            if (!nextPrayer) {
                nextPrayer = prayerTimes.sort((a, b) => a.diffMinutes - b.diffMinutes)[0];
            }
            if (!previousPrayer) {
                previousPrayer = prayerTimes.sort((a, b) => b.diffMinutes - a.diffMinutes)[0];
            }

            const isTimeForPraying = previousPrayer && previousPrayer.diffMinutes === 0;

            return { nextPrayer, previousPrayer, isTimeForPraying };
        }

        _updatePrayerHighlight(nextPrayerId, previousPrayerId) {
            if (!nextPrayerId && !previousPrayerId) {
                return;
            }

            for (const prayerId in this._prayItems) {
                const prayItem = this._prayItems[prayerId];
                if (!prayItem || !prayItem.menuItem || !prayItem.menuItem.actor) {
                    continue;
                }

                const { menuItem } = prayItem;
                menuItem.actor.remove_style_class_name('next-prayer');
                menuItem.actor.remove_style_class_name('previous-prayer');

                if (prayerId === nextPrayerId) {
                    menuItem.actor.add_style_class_name('next-prayer');
                } else if (prayerId === previousPrayerId) {
                    menuItem.actor.add_style_class_name('previous-prayer');
                }
            }
        }

        _calculatePrayerSeconds(timesFloat, prayerId) {
            return this._calculateSecondsFromHour(timesFloat[prayerId]);
        }

        _updateIslamicDate() {
            try {
                const hijriDate = HijriCalendarKuwaiti.KuwaitiCalendar(
                    this._opt_hijri_date_adjustment || 0
                );
                
                if (!hijriDate || !Array.isArray(hijriDate) || hijriDate.length < 8) {
                    this.logger.log('Invalid Hijri date returned');
                    return;
                }

                const outputIslamicDate = this._formatHijriDate(hijriDate);
                if (this._dateMenuItem && this._dateMenuItem.label) {
                    this._dateMenuItem.label.text = outputIslamicDate;
                }
            } catch (e) {
                this.logger.log('Error updating Islamic date: ' + e.message);
            }
        }

        _handlePrayerNotifications(
            nextPrayer,
            previousPrayer,
            timesStr,
            isTimeForPraying
        ) {
            if (
                this._opt_notify_before_azan > 0 &&
                nextPrayer.diffMinutes === this._opt_notify_before_azan &&
                !this._beforeAzanNotified
            ) {
                Main.notify(
                    ngettext(
                        'One minute remaining until %s prayer.',
                        '%d minutes remaining until %s prayer.',
                        this._opt_notify_before_azan
                    ).format(
                        this._opt_notify_before_azan,
                        this._timeNames[nextPrayer.id]
                    ),
                    _('Prayer time: %s').format(timesStr[nextPrayer.id])
                );
                this._beforeAzanNotified = true;
            }

            if (
                isTimeForPraying &&
                !this._azanNotified &&
                this._opt_notify_for_azan
            ) {
                Main.notify(
                    _("It's time for %s prayer.").format(
                        this._timeNames[previousPrayer.id]
                    ),
                    _('Prayer time: %s').format(timesStr[previousPrayer.id])
                );
                this._azanNotified = true;
            }
        }

        _updateIndicatorText(
            isTimeForPraying,
            nextPrayer,
            previousPrayer
        ) {
            if (isTimeForPraying) {
                this.indicatorText.set_text(
                    _('It’s time for %s prayer.').format(
                        this._timeNames[previousPrayer.id]
                    )
                );
                return;
            }

            const timeSince = this._formatRemainingTimeFromMinutes(previousPrayer.diffMinutes);
            const timeUntil = this._formatRemainingTimeFromMinutes(nextPrayer.diffMinutes);

            this.indicatorText.set_text(
                '%s +%s | %s -%s'.format(
                    this._timeNames[previousPrayer.id],
                    timeSince,
                    this._timeNames[nextPrayer.id],
                    timeUntil
                )
            );
        }

        _calculateSecondsFromDate(date) {
            if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
                return 0;
            }
            return (
                date.getHours() * SECONDS_PER_HOUR +
                date.getMinutes() * SECONDS_PER_MINUTE +
                date.getSeconds()
            );
        }

        _calculateSecondsFromHour(hour) {
            if (typeof hour !== 'number' || isNaN(hour) || !isFinite(hour)) {
                return 0;
            }
            return hour * SECONDS_PER_HOUR;
        }

        _formatRemainingTimeFromMinutes(diffMinutes) {
            if (typeof diffMinutes !== 'number' || isNaN(diffMinutes)) {
                return '00:00';
            }
            const absMinutes = Math.abs(diffMinutes);
            let hours = Math.floor(absMinutes / MINUTES_PER_HOUR);
            let minutes = absMinutes % MINUTES_PER_HOUR;

            return '%s:%s'.format(
                hours.toString().padStart(2, '0'),
                minutes.toString().padStart(2, '0')
            );
        }

        _formatHijriDate(hijriDate) {
            if (!hijriDate || !Array.isArray(hijriDate) || hijriDate.length < 8) {
                return _('Invalid date');
            }

            const dayIndex = hijriDate[4];
            const monthIndex = hijriDate[6];
            
            if (dayIndex < 0 || dayIndex >= this._dayNames.length ||
                monthIndex < 0 || monthIndex >= this._monthNames.length) {
                this.logger.log(`Invalid Hijri date indices: day=${dayIndex}, month=${monthIndex}`);
                return _('Invalid date');
            }

            return pgettext('format Hijri Date', '%s, %s %s %s').format(
                this._dayNames[dayIndex],
                hijriDate[5],
                this._monthNames[monthIndex],
                hijriDate[7]
            );
        }

        stop() {
            // Disconnect settings signals
            if (this._settingsChangedIds) {
                this._settingsChangedIds.forEach((id) => {
                    try {
                        this._settings.disconnect(id);
                    } catch (e) {
                        this.logger.log('Error disconnecting setting: ' + e.message);
                    }
                });
                this._settingsChangedIds = [];
            }

            // Remove periodic timeout
            if (this._periodicTimeoutId) {
                try {
                    GLib.source_remove(this._periodicTimeoutId);
                } catch (e) {
                    this.logger.log('Error removing timeout: ' + e.message);
                }
                this._periodicTimeoutId = null;
            }

            // Disconnect Geoclue location monitoring
            if (this._gclueLocationChangedId && this._gclueService) {
                try {
                    this._gclueService.disconnect(this._gclueLocationChangedId);
                } catch (e) {
                    this.logger.log('Error disconnecting Geoclue: ' + e.message);
                }
                this._gclueLocationChangedId = 0;
            }

            // Clean up Geoclue service
            this._gclueService = null;
            this._gclueStarting = false;

            // Remove menu items
            try {
                this.menu.removeAll();
            } catch (e) {
                this.logger.log('Error removing menu items: ' + e.message);
            }
        }
    }
);

let azan;

export default class AzanExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.athan_custom.sal0-h');
        this._updateAzan();
    }

    disable() {
        if (azan) {
            azan.stop();
            azan.destroy();
            azan = null;
        }
        this._settings = null;
    }

    _updateAzan() {
        if (azan) {
            azan.stop();
            azan.destroy();
            azan = null;
        }
        azan = new Azan(this);
    }
}