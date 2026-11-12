-- FwType 00000003
-- FwVersion 00aa55aa
-- HwType 00000013
-- HwVersion 00000001

--STORAGE
STO99999 = OBJECT:new(44, "STO99999")


-- setVar type support
_type = {}
CLU900000001 = OBJECT:new(0, 0xC0A80165, "CLU900000001")
-- NAME_CLU VCLU=CLU900000001

CLU900000002 = OBJECT:new(1, 0xC0A80166, "CLU900000002")
CLU900000003 = OBJECT:new(1, 0xC0A80167, "CLU900000003")
CLU900000004 = OBJECT:new(1, 0xC0A80168, "CLU900000004")
CLU900000005 = OBJECT:new(1, 0xC0A80169, "CLU900000005")
CLU1 = OBJECT:new(1, 0xC0A8016A, "CLU1")
CLU900000006 = OBJECT:new(1, 0xC0A8016B, "CLU900000006")

HTT9478 = GATE:new(120, "HTT9478")
-- NAME_PERIPHERY aaahttp=HTT9478

-- MODULES

-- IO_MODULES

aas = 4 -- number
_type["aas"] = "number"
aaab = false -- boolean
_type["aaab"] = "boolean"

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

function EventsFor_CLU900000001_20()
	elo(nil)
end
CLU900000001:add_event(20, EventsFor_CLU900000001_20)



function OnInit()

-- INIT_CLU_OBJECTS
CLU900000001:set(14, 22)
CLU900000001:set(20, "host1.example")
CLU900000001:set(21, 1)
CLU900000001:set(23, 1)
CLU900000001:set(24, "host2.example")
HTT9478:set(0, "/ELO")
HTT9478:set(2, "\z")
HTT9478:set(4, "\z")
HTT9478:set(5, "\z")
HTT9478:set(6, 1)
HTT9478:set(7, "\z")
HTT9478:set(8, "\z")
HTT9478:set(9, 200)

end

CLU900000001:add_event(0, OnInit)
STO99999:execute(2, "aas")
STO99999:execute(2, "aaab")
