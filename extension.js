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

            this._bindSettings();
            this._loadSettings();

            this._initTimeData();
            this._initUI();
            this._initServices();

            this._updateLabelPeriodic();
            this._updatePrayerVisibility();
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
                            if (error)
                                this.logger.log(
                                    'Error looking up permission: ' +
                                        error.message
                                );

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
                    } catch (e) {
                        this.logger.log(
                            'Failed to connect to Geoclue2 service: ' +
                                e.message
                        );
                        return;
                    }
                    this._gclueStarted = true;
                    this._gclueService.get_client().distance_threshold = 100;
                    this._updateLocationMonitoring();
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
            let geoLocation = this._gclueService.location;
            this._opt_latitude = geoLocation.latitude;
            this._opt_longitude = geoLocation.longitude;
            this._settings.set_double('latitude', this._opt_latitude);
            this._settings.set_double('longitude', this._opt_longitude);
        }

        _updateLocationMonitoring() {
            if (this._opt_auto_location) {
                if (
                    this._gclueLocationChangedId != 0 ||
                    this._gclueService == null
                )
                    return;

                this._gclueLocationChangedId = this._gclueService.connect(
                    'notify::location',
                    this._onGClueLocationChanged.bind(this)
                );
                this._onGClueLocationChanged();
            } else {
                if (this._gclueLocationChangedId)
                    this._gclueService.disconnect(this._gclueLocationChangedId);
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
            const currentDate = new Date();
            const currentSeconds = this._calculateSecondsFromDate(currentDate);

            const timesStr = this._getPrayerTimes(currentDate, 'String');
            const timesFloat = this._getPrayerTimes(currentDate, 'Float');

            for (const prayerId in this._timeNames) {
                this._prayItems[prayerId].label.text = timesStr[prayerId];
            }

            const {
                nearestPrayerId,
                diffMinutes,
                isTimeForPraying,
                isAfterAzan,
            } = this._findNearestPrayer(timesFloat, currentSeconds);

            if (nearestPrayerId !== this._lastNotifiedPrayerId) {
                this._azanNotified = false;
                this._beforeAzanNotified = false;
                this._lastNotifiedPrayerId = nearestPrayerId;
            }

            this._updateIslamicDate();
            this._handlePrayerNotifications(
                isAfterAzan,
                diffMinutes,
                nearestPrayerId,
                timesStr,
                isTimeForPraying
            );
            this._updateIndicatorText(
                isTimeForPraying,
                isAfterAzan,
                diffMinutes,
                nearestPrayerId,
                timesStr
            );
        }

        _getPrayerTimes(currentDate, format) {
            const myLocation = [this._opt_latitude, this._opt_longitude];
            const myTimezone = this._timezoneArr[this._opt_timezone];

            this._prayTimes.setMethod(
                this._calcMethodsArr[this._opt_calculation_method]
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
        }

        _findNearestPrayer(timesFloat, currentSeconds) {
            let nearestUpcomingPrayerId = null;
            let minDiffMinutes = Number.MAX_VALUE;
            let afterAzanInfo = null;

            for (const prayerId of this._primaryPrayers) {
                const prayerSeconds = this._calculatePrayerSeconds(
                    timesFloat,
                    prayerId,
                    currentSeconds
                );
                let diffSeconds = prayerSeconds - currentSeconds;

                // ? Handling wrap-around at midnight
                if (diffSeconds < -12 * 3600) {
                    diffSeconds += 24 * 3600;
                } else if (diffSeconds > 12 * 3600) {
                    diffSeconds -= 24 * 3600;
                }

                const diffMinutes = Math.floor(diffSeconds / 60);

                // ? If it’s prayer time
                if (diffMinutes === 0) {
                    return {
                        nearestPrayerId: prayerId,
                        diffMinutes: 0,
                        isTimeForPraying: true,
                        isAfterAzan: false,
                    };
                }

                // ? If prayer just ended (show "since athan" messages)
                if (diffMinutes < 0 && diffMinutes >= -15) {
                    if (
                        afterAzanInfo === null ||
                        diffMinutes > afterAzanInfo.diffMinutes
                    ) {
                        afterAzanInfo = {
                            nearestPrayerId: prayerId,
                            diffMinutes: diffMinutes,
                            isTimeForPraying: false,
                            isAfterAzan: true,
                        };
                    }
                }

                // ? Then find the nearest upcoming primary prayer
                if (diffMinutes > 0 && diffMinutes < minDiffMinutes) {
                    minDiffMinutes = diffMinutes;
                    nearestUpcomingPrayerId = prayerId;
                }
            }

            if (afterAzanInfo) {
                return afterAzanInfo;
            }

            return {
                nearestPrayerId: nearestUpcomingPrayerId,
                diffMinutes: minDiffMinutes,
                isTimeForPraying: false,
                isAfterAzan: false,
            };
        }

        _calculatePrayerSeconds(timesFloat, prayerId, currentSeconds) {
            let prayerSeconds = this._calculateSecondsFromHour(
                timesFloat[prayerId]
            );
            const ishaSeconds = this._calculateSecondsFromHour(
                timesFloat['isha']
            );
            const fajrSeconds = this._calculateSecondsFromHour(
                timesFloat['fajr']
            );

            if (prayerId === 'fajr' && currentSeconds > ishaSeconds) {
                prayerSeconds = fajrSeconds + 24 * 60 * 60;
            }

            return prayerSeconds;
        }

        _updateIslamicDate() {
            const hijriDate = HijriCalendarKuwaiti.KuwaitiCalendar(
                this._opt_hijri_date_adjustment
            );
            const outputIslamicDate = this._formatHijriDate(hijriDate);
            this._dateMenuItem.label.text = outputIslamicDate;
        }

        _handlePrayerNotifications(
            isAfterAzan,
            diffMinutes,
            nearestPrayerId,
            timesStr,
            isTimeForPraying
        ) {
            if (
                this._opt_notify_before_azan > 0 &&
                diffMinutes === this._opt_notify_before_azan &&
                !this._beforeAzanNotified
            ) {
                Main.notify(
                    // ? Arabic plural form
                    ngettext(
                        'One minute remaining until %s prayer.',
                        '%d minutes remaining until %s prayer.',
                        this._opt_notify_before_azan
                    ).format(
                        this._opt_notify_before_azan,
                        this._timeNames[nearestPrayerId]
                    ),
                    _('Prayer time: %s').format(timesStr[nearestPrayerId])
                );
                this._beforeAzanNotified = true;
            }

            if (
                isTimeForPraying &&
                !this._azanNotified &&
                this._opt_notify_for_azan
            ) {
                Main.notify(
                    _('It’s time for %s prayer.').format(
                        this._timeNames[nearestPrayerId]
                    ),
                    _('Prayer time: %s').format(timesStr[nearestPrayerId])
                );
                this._azanNotified = true;
            }
        }

        _updateIndicatorText(
            isTimeForPraying,
            isAfterAzan,
            diffMinutes,
            nearestPrayerId
        ) {
            if (isTimeForPraying) {
                this.indicatorText.set_text(
                    _('It’s time for %s prayer.').format(
                        this._timeNames[nearestPrayerId]
                    )
                );
                return;
            }

            if (isAfterAzan) {
                this.indicatorText.set_text(
                    pgettext('Extention indecator', '%s +%s').format(
                        this._timeNames[nearestPrayerId],
                        this._formatRemainingTimeFromMinutes(diffMinutes)
                    )
                );
                return;
            }

            // ? Default: Show time until the next prayer
            this.indicatorText.set_text(
                pgettext('Extention indecator', '%s -%s').format(
                    this._timeNames[nearestPrayerId],
                    this._formatRemainingTimeFromMinutes(diffMinutes)
                )
            );
        }

        _calculateSecondsFromDate(date) {
            return (
                date.getHours() * 3600 +
                date.getMinutes() * 60 +
                date.getSeconds()
            );
        }

        _calculateSecondsFromHour(hour) {
            return hour * 3600;
        }

        _formatRemainingTimeFromMinutes(diffMinutes) {
            let hours = Math.floor(Math.abs(diffMinutes) / 60);
            let minutes = Math.abs(diffMinutes) % 60;

            return '%s:%s'.format(
                hours.toString().padStart(2, '0'),
                minutes.toString().padStart(2, '0')
            );
        }

        _formatHijriDate(hijriDate) {
            return pgettext('format Hijri Date', '%s, %s %s %s').format(
                this._dayNames[hijriDate[4]],
                hijriDate[5],
                this._monthNames[hijriDate[6]],
                hijriDate[7]
            );
        }

        stop() {
            this._settingsChangedIds.forEach((id) => {
                this._settings.disconnect(id);
            });
            this._settingsChangedIds = [];

            if (this._periodicTimeoutId) {
                GLib.source_remove(this._periodicTimeoutId);
                this._periodicTimeoutId = null;
            }

            if (this._gclueLocationChangedId) {
                this._gclueService.disconnect(this._gclueLocationChangedId);
                this._gclueLocationChangedId = 0;
            }

            this.menu.removeAll();
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