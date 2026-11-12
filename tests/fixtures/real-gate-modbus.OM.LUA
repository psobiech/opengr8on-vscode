-- FwType 00000001
-- FwVersion 00000578
-- HwType 00000012
-- HwVersion 00000002


-- setVar type support
_type = {}
CLU900000003 = GATE:new(5000, 0xC0A80167, 0xFFFFFF00, 0xC0A8016C, "", "")
-- NAME_CLU MODBUS=CLU900000003

CLU900000002 = OBJECT:new(1, 0xC0A80166, "CLU900000002")
CLU900000004 = OBJECT:new(1, 0xC0A80168, "CLU900000004")
CLU900000005 = OBJECT:new(1, 0xC0A80169, "CLU900000005")
CLU900000006 = OBJECT:new(1, 0xC0A8016A, "CLU900000006")
CLU1 = OBJECT:new(1, 0xC0A8016B, "CLU1")
CLU900000001 = OBJECT:new(1, 0xC0A80165, "CLU900000001")

MOD8301 = GATE:new(206, "MOD8301")
-- NAME_PERIPHERY modbserv=MOD8301

-- MODULES

-- IO_MODULES


function toboolean(value)
    local valueType = type(value)
    if valueType == "boolean" then
      return value
    elseif valueType == "number" then
      return value ~= 0
    elseif valueType == "string" then
      local numeric = tonumber(value)
      if numeric ~= nil then
         return numeric ~= 0
      elseif value == "false" then
         return false
      end
      return value and true
    elseif valueType == "nil" then
      return false
    end
    return value and true
end

function setVar(name, value)
    t = _type[name]
    if(t == "string") then
        _G[name] = tostring(value)
    elseif(t == "number") then
        _G[name] = tonumber(value)
    elseif(t == "boolean") then
        _G[name] = toboolean(value)
    else
        _G[name] = value
    end
end

function getVar(name)
	return _G[name]
end



function OnInit()

-- INIT_CLU_OBJECTS
CLU900000003:set(1, 1000)
CLU900000003:set(14, 0)
CLU900000003:set(18, 0)
CLU900000003:set(20, 5000)
CLU900000003:set(21, 1)
CLU900000003:set(2, "192.0.2.1")
CLU900000003:set(3, "192.0.2.2")
CLU900000003:set(23, 0)
CLU900000003:set(24, 0)
CLU900000003:set(27, 0)
CLU900000003:set(25, 0)
MOD8301:set(1, 502)
MOD8301:set(2, 255)
MOD8301:set(3, 1)
MOD8301:set(4, 2)
MOD8301:set(6, 0)
MOD8301:set(7, 16)
MOD8301:set(8, 1)
MOD8301:set(9, "0")

end

CLU900000003:add_event(0, OnInit)
