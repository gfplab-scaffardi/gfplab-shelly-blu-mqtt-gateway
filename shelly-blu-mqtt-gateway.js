/**
 * @title Shelly BLU MQTT Gateway for Giano Supervisor
 * @description This scripts auto configures itself for decoding specific list of BTHOME devices (from a MQTT whitelist) and publish the status over MQTT
 * @link https://www.gfplab.com/solutions
 * @status production
 *
 * Original Shelly Script/License
 * @link https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble/ble-shelly-dw.shelly.js
 */
 
let DEBUG_ENABLED = true ;
let DEBUG_UNKNOWN_MAC = false ; // Log each unknown BLE MAC once (not in whitelist)
let USE_EVENTS = false ; // Slower method
let GFP_BLE_EVENT = "gfp_ble";
let MQTT_QOS = 0 ;
let MQTT_RETAIN = false ;
let ENABLE_TIMER_PUBLISH = false ; // Do not publish repeatly
let TIMER_PERIOD_MS = 60000 ;

if (DEBUG_ENABLED) console.log("Starting");

let CONFIG = {
  device_id: "",
  device_mac: "", 
  device_model: "",
  fw_ver: "",
  topic_prefix: "",
  mqtt_connected: false,
  mqtt_subscribed: false,
  //device_ip: "",
};

let TOPIC_GFPLAB = "gfplab";
let TOPIC_STATUS = "status";

// BTHOME (https://bthome.io/)

let TYPE_BTHOME = "bthome";

let BTHOME_MFD_ID_STR = "0ba9";
let BTHOME_SVC_ID_STR = "fcd2";

let BTHOME_MFD_ID = JSON.parse("0x" + BTHOME_MFD_ID_STR);
let BTHOME_SVC_ID = JSON.parse("0x" + BTHOME_SVC_ID_STR);

let uint8 = 0;
let int8 = 1;
let uint16 = 2;
let int16 = 3;
let uint24 = 4;
let int24 = 5;
let uint32 = 6;

function getByteSize(type) {
  if (type === uint8 || type === int8) return 1;
  if (type === uint16 || type === int16) return 2;
  if (type === uint24 || type === int24) return 3;
  if (type === uint32) return 4;
  //impossible as advertisements are much smaller;
  return 255;
}

// BTHome object IDs — aligned with Shelly BLU examples + newer device metadata (0xf0–0xf2)
let BTH = [];
BTH[0x00] = { n: "pid", t: uint8 };
BTH[0x01] = { n: "battery", t: uint8, u: "%" };
BTH[0x02] = { n: "temperature", t: int16, f: 0.01, u: "tC" };
BTH[0x03] = { n: "humidity", t: uint16, f: 0.01, u: "%" };
BTH[0x05] = { n: "illuminance", t: uint24, f: 0.01 };
BTH[0x21] = { n: "motion", t: uint8 };
BTH[0x2d] = { n: "window", t: uint8 };
BTH[0x2e] = { n: "humidity", t: uint8, u: "%" };
BTH[0x3a] = { n: "button", t: uint8 };
BTH[0x3f] = { n: "rotation", t: int16, f: 0.1 };
BTH[0x41] = { n: "distance", t: uint16, f: 0.1 };
BTH[0x45] = { n: "temperature", t: int16, f: 0.1, u: "tC" };
BTH[0x64] = { n: "light_level", t: uint8 }; // 0=dark, 1=twilight, 2=bright (BTHome v2)
BTH[0x15] = { n: "battery_low", t: uint8 }; // 0=ok, 1=low
BTH[0x2b] = { n: "tamper", t: uint8 }; // 0=off, 1=on
BTH[0x65] = { n: "settings_revision", t: uint8 };
BTH[0xf0] = { n: "device_type_id", t: uint16 };
BTH[0xf1] = { n: "firmware_version", t: uint32 };
BTH[0xf2] = { n: "extra_data", t: uint24 };
// Legacy IDs (older BLU payloads)
BTH[0x1a] = { n: "door", t: uint8 };
BTH[0x20] = { n: "moisture", t: uint8 };

function bthSetResult(result, name, value) {
  if (typeof result[name] === "undefined") {
    result[name] = value;
    return;
  }
  if (Array.isArray(result[name])) {
    result[name].push(value);
  } else {
    result[name] = [result[name], value];
  }
}

let CommonDecoder = {
  utoi: function (num, bitsz) {
    let mask = 1 << (bitsz - 1);
    return num & mask ? num - (1 << bitsz) : num;
  },
  getUInt8: function (buffer) {
    return buffer.at(0);
  },
  getInt8: function (buffer) {
    return this.utoi(this.getUInt8(buffer), 8);
  },
  getUInt16LE: function (buffer) {
    return 0xffff & ((buffer.at(1) << 8) | buffer.at(0));
  },
  getInt16LE: function (buffer) {
    return this.utoi(this.getUInt16LE(buffer), 16);
  },
  getUInt24LE: function (buffer) {
    return (
      0x00ffffff & ((buffer.at(2) << 16) | (buffer.at(1) << 8) | buffer.at(0))
    );
  },
  getInt24LE: function (buffer) {
    return this.utoi(this.getUInt24LE(buffer), 24);
  },
  getUInt32LE: function (buffer) {
    return (
      0xffffffff &
      ((buffer.at(3) << 24) |
        (buffer.at(2) << 16) |
        (buffer.at(1) << 8) |
        buffer.at(0))
    );
  },
  getBufValue: function (type, buffer) {
    if (buffer.length < getByteSize(type)) return null;
    let res = null;
    if (type === uint8) res = this.getUInt8(buffer);
    if (type === int8) res = this.getInt8(buffer);
    if (type === uint16) res = this.getUInt16LE(buffer);
    if (type === int16) res = this.getInt16LE(buffer);
    if (type === uint24) res = this.getUInt24LE(buffer);
    if (type === int24) res = this.getInt24LE(buffer);
    if (type === uint32) res = this.getUInt32LE(buffer);
    return res;
  },
};

let BTHomeParser = {
  id: "bthome",
  type: TYPE_BTHOME,
//  mfd_id: ALLTERCO_MFD_ID,
  svc_id: BTHOME_SVC_ID,
  unpack: function (res,cache) {
 //  console.log(JSON.stringify(res)); 

    if (typeof res.service_data === "undefined") return;
    let buffer = res.service_data[BTHOME_SVC_ID_STR];
    if (typeof buffer === "undefined") return;
      
//    console.log("Got buffer:" , typeof buffer);
      
    // beacons might not provide BTH service data
    if (typeof buffer !== "string" || buffer.length === 0) return null;
    
//    console.log("Payload:");

    let result = {};
    let _dib = buffer.at(0);
    result["encryption"] = _dib & 0x1 ? true : false;
    result["bthome_version"] = _dib >> 5;
    if (result["bthome_version"] !== 2) return null;
    //Can not handle encrypted data
    if (result["encryption"]) return result;
    buffer = buffer.slice(1);

 //     console.log(typeof cache);
 //      console.log(JSON.stringify(cache)); 

    let _bth;
    let _value;
    let _objId;
    while (buffer.length > 0) {
      _objId = buffer.at(0);
      _bth = BTH[_objId];
      if (typeof _bth === "undefined") {
        if (DEBUG_ENABLED) console.log("BTH: unknown object id 0x" + _objId.toString(16));
        break;
      }
      buffer = buffer.slice(1);
      _value = CommonDecoder.getBufValue(_bth.t, buffer);
      if (_value === null) break;
      if (typeof _bth.f !== "undefined") _value = _value * _bth.f;
      bthSetResult(result, _bth.n, _value);
      buffer = buffer.slice(getByteSize(_bth.t));
    }
    
    // Skip duplicate packets
    if (cache !== null && typeof cache === "object" && typeof cache.pid !== "undefined" && typeof result["pid"] !== "undefined") {
      if (cache.pid === result["pid"]) {
        result = null;
      }
    }
    
    // console.log(JSON.stringify(result)); 
    
    return result;
  },
};

// MINEW S4

let MFG_ID_MINEW = "0639";
let MINEW_FRAME_TYPE_S4 = 0xA4;
let MINEW_VER_STATIC = 0 ;
let MINEW_VER_DATA = 1 ;
let TYPE_MINEW_S4_DOORWINDOW = "minew_s4";

let MinewS4BLEParser = {
  id: "minew",
  type: TYPE_MINEW_S4_DOORWINDOW,
  mfg_id: MFG_ID_MINEW,
 
  unpack: function(res,cache) {
    let bleData = res.manufacturer_data[MFG_ID_MINEW];
    if (typeof bleData === "undefined")
      return ;
    //console.log("pew");
        let result = null ;
    // S4 DOORWINDOW
    //console.log("minew");
    if (bleData.at(0) === MINEW_FRAME_TYPE_S4) { 
    //console.log("s4");
      if (bleData.at(1) === MINEW_VER_DATA) {
    //console.log("data");
        // a4   01   64      01   00     00    ff    64 dc a4 3f 23 ac    e5 71 (15 bytes)
        // TYPE VER  BATTERY DOOR TAMPER ALARM TBD   BTADDR               RANDOM
        result = {
            deviceType: bleData.at(0),
            ver: bleData.at(1),
            battery: bleData.at(2),
            door: bleData.at(3),
            tamper: bleData.at(4),
            alarm: bleData.at(5),
        };    
      }
    }
    return result;
  }
}; 

// PARSERS

let PARSERS = [
  MinewS4BLEParser,
  BTHomeParser,
];

// OTHER STUFF

function isConfigReady() {
  for (let key in CONFIG) {
    var val = CONFIG[key];
    //console.log(key + "=" + val);  
    if (CONFIG[key] === "") return false;
  }
  return true;
}

// Shelly mJS: no function hoisting — define MQTT/BLE helpers before any Shelly.call uses them
let GFP_BLE_WL = [];
let GFP_BLE_UNKNOWN_SEEN = {};

function isMacWhitelisted(addr) {
  let mac = addr.toLowerCase();
  for (let i = 0; i < GFP_BLE_WL.length; i++) {
    if (GFP_BLE_WL[i].mac === mac) return true;
  }
  return false;
}

function logUnknownMacIfNeeded(res) {
  if (!DEBUG_UNKNOWN_MAC) return;
  if (typeof res.addr === "undefined") return;
  let mac = res.addr.toLowerCase();
  if (isMacWhitelisted(mac)) return;
  if (GFP_BLE_UNKNOWN_SEEN[mac]) return;
  GFP_BLE_UNKNOWN_SEEN[mac] = true;
  let hint = "";
  if (typeof res.service_data !== "undefined" && typeof res.service_data[BTHOME_SVC_ID_STR] !== "undefined") {
    hint = " bthome";
  } else if (typeof res.manufacturer_data !== "undefined" && typeof res.manufacturer_data[MFG_ID_MINEW] !== "undefined") {
    hint = " minew";
  }
  console.log("+ble.unknown", mac, "rssi:", res.rssi + hint);
}

function whitelist_reset() {
    if(DEBUG_ENABLED)console.log("+ble.wl reset");  
    GFP_BLE_WL = [];
}

function whitelist_add(value) {
    value.mac = value.mac.toLowerCase() ;
    if(DEBUG_ENABLED) console.log("+ble.wl[", GFP_BLE_WL.length,"]",value.mac);  
    value["cache"] = null;
    value["count"] = 0 ;
    GFP_BLE_WL.push(value);
}

function mqttConfigHandler(topic, message) {
    console.log("MQTT config received");

    if (typeof message === "undefined") return;
    let json = JSON.parse(message) ;
    if (typeof json === "undefined") return;    
    
    let ble = json.ble ;
    if (typeof ble === "undefined") return;    
    
    let wl = ble.wl ;
    if (typeof wl === "undefined") return;    

    whitelist_reset();        
    for (let idx=0; idx<wl.length; idx++) {
        let value = wl[idx];
        if (typeof value === "undefined") return; 
        whitelist_add(value);
    }
}

function mqtt_connected_set(status) {
  console.log("MQTT_connected=", status);
  if(CONFIG.mqtt_connected == status)
	return ;
  console.log("MQTT_connected changed");
  
  if(status == false) {
    CONFIG.mqtt_subscribed = false ;
  } else {
    if(CONFIG.mqtt_subscribed !== true) {
        console.log("MQTT config subscribed");
        MQTT.subscribe(CONFIG.topic_prefix + "/gfplab/config", mqttConfigHandler);
  	    CONFIG.mqtt_subscribed = true ;
  	    return ;
    }
  }
  CONFIG.mqtt_connected = status ;
}

MQTT.setConnectHandler(function (userdata) {
  mqtt_connected_set(true);
});

MQTT.setDisconnectHandler(function (userdata) {
  mqtt_connected_set(false);
});

Shelly.call("Shelly.GetDeviceInfo", null, function (info) {
// {"auth_domain":null,"auth_en":false,"app":"Plus1","ver":"0.14.1","fw_id":"20230308-091529/0.14.1-g22a4cb7","gen":2,"model":"SNSW-001X16EU","mac":"7C87CE734C00","id":"shellyplus1-7c87ce734c00","name":null}
  if(DEBUG_ENABLED) console.log("Got Shelly.GetDeviceInfo");  
  CONFIG.device_id = info.id;
  CONFIG.device_mac = info.mac;
  CONFIG.device_model = info.model;
  CONFIG.fw_ver = info.fw_id;
  /*
  for (let key in CONFIG) {
    var val = CONFIG[key];
    console.log(key + "=" + val);  
  }*/
});

/*Read ip from status
Shelly.call("WiFi.GetStatus", null, function (status) {
  if (status.status === "got ip") {
    CONFIG.wifi_ip = status.sta_ip;
    console.log("WiFi: connected");
  }
});

//Monitor ip changes
Shelly.addStatusHandler(function (status) {
  if (status.component === "wifi" && status.delta.status === "got ip") {
     if  (DEBUG_ENABLED) console.log("Got WiFi IP");  
     CONFIG.device_ip = status.delta.sta_ip;
     if  (DEBUG_ENABLED) console.log("CONFIG.wifi_ip="+CONFIG.wifi_ip);  
  }
});
*/

//Read mqtt topic prefix
Shelly.call("MQTT.GetConfig", null, function (config) {
    if(DEBUG_ENABLED) console.log("Got MQTT.GetConfig");  
    if(config.topic_prefix === "") {
      CONFIG.topic_prefix = CONFIG.device_id ;
    } else {
      CONFIG.topic_prefix = config.topic_prefix;
    }
    if(DEBUG_ENABLED) console.log("CONFIG.topic_prefix="+CONFIG.topic_prefix);  
    
    let connected = MQTT.isConnected() ;
    mqtt_connected_set(connected);
});

function toHexDigit(digit,upcase) {
  let ret = '';
  if (digit < 10) {
    ret = chr('0'.at(0)+digit); // chr('0' + digit) ;
  } else {
    if (upcase) {
     ret = chr('A'.at(0)+digit-10); // chr('a' + digit - 10) ;
   } else {   
     ret = chr('a'.at(0)+digit-10); // chr('a' + digit - 10) ;
   }
  }
  return ret ;
}

function toHexByte(byte,upcase) {
  let ret = '' ;  
  ret = toHexDigit((byte >> 4), upcase) + toHexDigit((byte & 0xf),upcase) ;
  return ret;
}
 
function toHexString(byteArray,upcase) {
  let ret = '';
   for(let i=0; i<byteArray.length; i++) {
     ret = ret + toHexByte(byteArray[i],upcase);
     //a.splice(start, deleteCount, ...);
   }
   return ret ;
}

function toDeviceId(s) {
  let ret = '';
   for(let i=0; i<s.length; i++) {
     let c = s[i];
     if (c === ':') {
     } else {
       let aChar = 'a'.at(0) ;
       let zChar = 'z'.at(0) ;
       let cChar = c.at(0) ;
       let min = (cChar >= aChar); 
       let max = (cChar <= zChar) ;
    //  console.log("aChar",aChar," zChar", zChar);
     // console.log("c=",c," >= a=", min, "<= z=" ,max);
        
       if (min && max) {
         c = chr(cChar - aChar + 'a'.at(0)); // Was uppercase, now lowercase
         ret += c ;
       } else {
         ret += c ;
       }
     }
//     ret = ret + toHexByte(byteArray[i],upcase);
     //a.splice(start, deleteCount, ...);
   }
   return ret ;
}
/*
console.log("hexDigit(7)=", toHexDigit(0x7,false));
console.log("hexDigit(a)=", toHexDigit(0xa,false));
console.log("hexByte(ab)=", toHexByte(0xab,false));
console.log("hexString(abcd12)=", toHexString([0xab, 0xcd, 0x12], true));
console.log("toDeviceId('a1:a2:A3:00')="+toDeviceId("a1:a2:A3:00"));
*/

let GFP_PREFIX = "gfp";
let GFP_BLE_PREFIX = GFP_PREFIX + ".ble";
let GFP_BLE_WL_PREFIX = GFP_BLE_PREFIX + ".wl";

// Get GFP BLE WL settings
Shelly.call("KVS.GetMany", {
            match: GFP_BLE_WL_PREFIX + ".*"
},  function (result, error_code, error_message) {
      if(DEBUG_ENABLED) console.log("Got KVS.GetMany");  
      if (error_code !== 0) {
          die("Error "+error_code);
      }
      
      for (let item in result.items) {
        let obj = result.items[item];
        //console.log("obj ",obj); 
        if (typeof obj === "undefined") continue;
        let value = JSON.parse(obj.value) ;
        if (typeof value === "undefined") continue;            
        whitelist_add(value);
      }
     // die("Entries: "+wl.length);      
    }
);

function publish_device(type, addr, status) {
      if (!isConfigReady()) {
      if(DEBUG_ENABLED)
        console.log("Config not ready!");
     return false;
     }
          
      //console.log(typeof(addr));
      let device_id = toDeviceId(addr) ;
      let topic = TOPIC_GFPLAB + "/ble/" + type +"-" + device_id + "/" +TOPIC_STATUS; 
       if(DEBUG_ENABLED) console.log(topic);

      if (!MQTT.isConnected()) {
          if(DEBUG_ENABLED)
            console.log("MQTT not connected");
         return false;
       }
        
       MQTT.publish(topic, JSON.stringify(status), MQTT_QOS, MQTT_RETAIN);
//      MQTT.publish(CONFIG.topic_prefix + "/" + res.addr, JSON.stringify(event));
//      Shelly.emitEvent("%event_type%", []);
     return true ;
}

function publish_device_status(entry) {
      // entry->cache => status JSON
      let ret = {};
      ret["data"] = entry.cache ;
      ret["type"] = entry.type ;
      ret["addr"] = entry.mac ;
      ret["desc"] = entry.desc ;
      
      let gw = {
        "id": CONFIG.device_id,
//        "ip": CONFIG.device_ip,
        "mac": CONFIG.device_mac,
        "model": CONFIG.device_model,
        "rssi": entry.rssi
      };
      // {"available_updates":{},"webhook_rev":0,"schedule_rev":0,"kvs_rev":1,"cfg_rev":10,"fs_free":69632,"fs_size":458752,"ram_free":118180,"ram_size":248564,"uptime":344902,"unixtime":1681150199,"time":"20:09","restart_required":false,"mac":"7C87CE734C00"}
      let system_status = Shelly.getComponentStatus("sys") ;
      if (system_status !== null) {
          let unixtime = system_status["unixtime"];
          if (unixtime !== null) {
            gw["unixtime"] = unixtime;
          }
      }
      ret["gw"] = gw ;
      if(publish_device(entry.type, entry.mac, ret)) {
             entry.tobesent = false ;
      }
}

function get_parser(type) {
  let ret = null ;
   let len = PARSERS.length ;
   let i ;
        
    //console.log(typeof(res.advData));
    //console.log("len: ", len);
    //print ("Got ", res.addr);
    for(i=0; i<len; i++) {
      let parser = PARSERS[i];
      if (type === parser.id) {
        ret = parser ;
        break;
      }
   }
  return ret ;
}
//console.log(get_parser(TYPE_MINEW_S4_DOORWINDOW));

// aioshelly BLE script 1.0
BLE.Scanner.Subscribe(function (ev, res) {
    if (ev === BLE.Scanner.SCAN_RESULT) {
        let i;
        let len = GFP_BLE_WL.length ;
        for(i=0; i<len; i++) {
          let entry = GFP_BLE_WL[i];
          let mac = entry.mac ;
          let same = mac === res.addr ;
          if (same) {
            entry.rssi = res.rssi;
            let type = entry.type ;
            let parser = get_parser(type);
            if (parser === null) 
              return ;
            {
               let data = parser.unpack(res,entry.cache);
               if (data === null) 
                  return ;
               // Confronto contenuto oggetto, non solo reference
               
               //console.log(data);
               //if (entry.cache) console.log(entry.cache);
               
               if (entry.cache && (JSON.stringify(entry.cache) === JSON.stringify(data))) {
                   return ;
               }
               //console.log("changed");

                entry.cache = data ;
                entry.count++ ;
                if(entry.tobesent === true) {
                  return;
                }
                entry.tobesent = true ;
                if(USE_EVENTS) {
                  Shelly.emitEvent(GFP_BLE_EVENT, entry);
                } else {
                  publish_device_status(entry);
                }
                return ;
            }
          }
        }
        logUnknownMacIfNeeded(res);
      }
    }
);

if(USE_EVENTS) {
  Shelly.addEventHandler(
    function (e, ud) {
      if(USE_EVENTS) {
         if (e.info.event === GFP_BLE_EVENT) {
            //print("Button was pushed");
            publish_device_status(e.info.data);
         }
      }
    },
    null // User data
  );
}

if (!BLE.Scanner.isRunning()) {
    BLE.Scanner.Start(
    {
        duration_ms: BLE.Scanner.INFINITE_SCAN,
        active: false,
    //   interval_ms: 320,
    //   window_ms: 30,
    });
}

// Send cached status periodically
if (ENABLE_TIMER_PUBLISH)
let timer_handle = Timer.set(TIMER_PERIOD_MS, true, function() {
  let len = GFP_BLE_WL.length ;
  for(i=0; i<len; i++) {
    let entry = GFP_BLE_WL[i];
    if (entry.cache) {
      publish_device_status(entry);
    }
  }
});

console.log("BLE scanner: started");

/*

BUGS: not subscribing config topic at reboot!

*/
