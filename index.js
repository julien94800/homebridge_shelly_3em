var inherits = require('util').inherits;
var Service, Characteristic;
var request = require('request');
var FakeGatoHistoryService = require('fakegato-history');
const version = require('./package.json').version;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.platformAccessory;
	UUIDGen = homebridge.hap.uuid;
	FakeGatoHistoryService = require('fakegato-history')(homebridge);
	homebridge.registerAccessory("homebridge_shelly_3em", "shelly_3em", EnergyMeter);

}


function EnergyMeter(log, config) {
	this.log = log;
	this.ip = config["ip"] || "127.0.0.1";
	this.Channel = config["Channel"] || "0";
	this.url = "http://" + this.ip + "/status/emeters?";
	this.url_Reset = "http://" + this.ip + "/emeter/" + config.Channel + "?reset_totals=true";
	this.auth = config["auth"];
	this.name = config["name"];
	this.displayName = config["name"];
	this.timeout = config["timeout"] || 5000;
	this.http_method = "GET";
	this.update_interval = Number(config["update_interval"] || 10000);
	this.negative_handling_mode = config["negative_handling_mode"] || 0;
	this.use_pf = config["use_pf"] || false;
	this.debug_log = config["debug_log"] || false;
	this.auto_on_Watt = config["Auto_On_Value"] || 20;
	this.serial = config.serial + config.Channel || "9000000";

	// internal variables
	this.waiting_response = false;
	this.powerConsumption = 0;
	this.totalPowerConsumption = 0;
	this.voltage1 = 0;
	this.ampere1 = 0;
	this.pf0 = 1;
	this.pf1 = 1;
	this.pf2 = 1;


	// Create Accessory Info Service
	const infoSubtype = "Info-" + this.serial;
	this.informationService = new Service.AccessoryInformation(this.name, infoSubtype);
	this.informationService
		.setCharacteristic(Characteristic.Manufacturer, "Shelly - Paname")
		.setCharacteristic(Characteristic.Model, "Shelly 3EM")
		.setCharacteristic(Characteristic.FirmwareRevision, version)
		.setCharacteristic(Characteristic.SerialNumber, this.serial);

	// Create Outlet Service
	const outletSubtype = "outlet-" + this.serial;
	this.serviceSwitch = new Service.Outlet(this.name, outletSubtype);
	this.serviceSwitch.getCharacteristic(Characteristic.On)
      		.on('set', this.setPowerState.bind(this));

	// Create FakeGato Service
	this.historyService = new FakeGatoHistoryService("energy", this.informationService, { storage: 'fs' });

	//Create custom characteristics
	var EvePowerConsumption = function () {
		Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.UINT16,
			unit: "Watts",
			maxValue: 100000,
			minValue: 0,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	EvePowerConsumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
	inherits(EvePowerConsumption, Characteristic);

	var EveTotalConsumption = function () {
		Characteristic.call(this, 'Energy', 'E863F10C-079E-48FF-8F27-9C2605A29F52');
		this.setProps({
			format: Characteristic.Formats.FLOAT,
			unit: 'kWh',
			maxValue: 1000000000,
			minValue: 0,
			minStep: 0.001,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
		});
		this.value = this.getDefaultValue();
	};
	EveTotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
	inherits(EveTotalConsumption, Characteristic);

	// local vars
	this._EvePowerConsumption = EvePowerConsumption;
	this._EveTotalConsumption = EveTotalConsumption;

	this.serviceSwitch.getCharacteristic(this._EvePowerConsumption).on('get', this.getPowerConsumption.bind(this));
	this.serviceSwitch.addCharacteristic(this._EveTotalConsumption).on('get', this.getTotalConsumption.bind(this));
}

EnergyMeter.prototype.updateState = function () {
	if (this.waiting_response) {
		this.log('Please select a higher update_interval value. Http command may not finish!');
		return;
	}
	this.waiting_response = true;
	this.last_value = new Promise((resolve, reject) => {
		var ops = {
			uri: this.url,
			method: this.http_method,
			timeout: this.timeout
		};
		if (this.debug_log) { this.log('Requesting energy values from Shelly 3EM(EM) ...'); }
		if (this.auth) {
			ops.auth = {
				user: this.auth.user,
				pass: this.auth.pass
			};
		}
		request(ops, (error, res, body) => {
			var json = null;
			if (error) {
				this.log('Bad http response! (' + ops.uri + '): ' + error.message);
			}
			else {
				try {
					json = JSON.parse(body);
					if (json.time === "16:06" && parseFloat(json.emeters[this.Channel].total) > 1) {
						var reset_request ={
								uri: this.url_Reset,
								method: this.http_method,
								timeout: this.timeout
						}
						if (this.auth) {
							reset_request.auth = {
								user: this.auth.user,
								pass: this.auth.pass
							}};
						request(reset_request, (err, resagain, txt) => {
    						if (err) {
        							this.log('Error resetting totals: ' + err.message);
    							} else {
        							this.log('Reset successful: ' + txt);
    							}
						});
					}

					this.pf0 = parseFloat(json.emeters[0].pf);
					this.pf1 = parseFloat(json.emeters[1].pf);
					this.pf2 = parseFloat(json.emeters[2].pf);

					if (this.negative_handling_mode == 0) {
						this.powerConsumption = (parseFloat(json.emeters[this.Channel].power));
						this.totalPowerConsumption = ((parseFloat(json.emeters[this.Channel].total)) / 1000);
						this.voltage1 = (((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
						this.ampere1 = (((parseFloat(json.emeters[this.Channel].current) * this.pf0)));
						if (this.powerConsumption < 0) { this.powerConsumption = 0 }
						if (this.totalPowerConsumption < 0) { this.totalPowerConsumption = 0 }
						if (this.voltage1 < 0) { this.voltage1 = 0 }
						if (this.ampere1 < 0) { this.ampere1 = 0 }
					} else if (this.negative_handling_mode == 1) {
						this.powerConsumption = Math.abs(parseFloat(json.emeters[this.Channel].power));
						this.totalPowerConsumption = Math.abs((parseFloat(json.emeters[this.Channel].total)) / 1000);
						this.voltage1 = Math.abs(((parseFloat(json.emeters[0].voltage) + parseFloat(json.emeters[1].voltage) + parseFloat(json.emeters[2].voltage)) / 3));
						this.ampere1 = Math.abs(((parseFloat(json.emeters[this.Channel].current) * this.pf0)));
					}

					if (this.debug_log) { this.log('Successful http response. [ voltage: ' + this.voltage1.toFixed(0) + 'V, current: ' + this.ampere1.toFixed(1) + 'A, consumption: ' + this.powerConsumption.toFixed(0) + 'W, total consumption: ' + this.totalPowerConsumption.toFixed(2) + 'kWh ]'); }
				}
				catch (parseErr) {
					this.log('Error processing data: ' + parseErr.message);
					error = parseErr;
				}
			}
			if (!error) {

				resolve(this.powerConsumption, this.totalPowerConsumption, this.voltage1, this.ampere1)
			}
			else {
				reject(error);
			}
			this.waiting_response = false;
		});
	})
		.then((value_current, value_total, value_voltage1, value_ampere1) => {
			
			if (value_current != null) {
				this.serviceSwitch.getCharacteristic(this._EvePowerConsumption).setValue(value_current, undefined, undefined);
				//FakeGato
				this.historyService.addEntry({ time: Math.round(new Date().valueOf() / 1000), power: value_current });
			}
			if (value_total != null) {
				this.service.getCharacteristic(this._EveTotalConsumption).setValue(value_total, undefined, undefined);
			}
			if (this.powerConsumption > this.auto_on_Watt) {  // Si la consommation dépasse 20 kW
				if (this.serviceSwitch.getCharacteristic(Characteristic.On).value===false) {
					this.log.info("Switching switch to ON cause consumption = " + this.powerConsumption + " and prev state was " + this.serviceSwitch.getCharacteristic(Characteristic.On).value);
					this.setPowerState(true, () => {});
					//this.historyService.addEntry({time: Math.round(new Date().valueOf() / 1000), status: 1});
					};
			} else {
				if (this.serviceSwitch.getCharacteristic(Characteristic.On).value===true) {
					this.log.info("Switching switch to OFF cause consumption = " + this.powerConsumption + " and prev state was " + this.serviceSwitch.getCharacteristic(Characteristic.On).value);
					this.setPowerState(false, () => {});
					//this.historyService.addEntry({time: Math.round(new Date().valueOf() / 1000), status: 0});
					};
			}

			return true;
		}, (error) => {
			return error;
		});
};

EnergyMeter.prototype.getPowerConsumption = function (callback) {
	callback(null, this.powerConsumption);
};

EnergyMeter.prototype.getTotalConsumption = function (callback) {
	callback(null, this.totalPowerConsumption);
};

EnergyMeter.prototype.getSwitch1 = function (callback) {
	callback(null, this.powerConsumption > this.auto_on_Watt);
};

EnergyMeter.prototype.setPowerState = function (state , callback) {
	this.serviceSwitch.getCharacteristic(Characteristic.On).updateValue(state)
    callback();
  };

EnergyMeter.prototype.getServices = function () {
	this.log("getServices: " + this.name);
	if (this.update_interval > 0) {
		this.timer = setInterval(this.updateState.bind(this), this.update_interval);
	}
	return [this.informationService, this.serviceSwitch ,this.historyService];
};

