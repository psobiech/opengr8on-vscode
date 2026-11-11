

function ELO()

--BEGIN_INIT
--END_INIT

	function printAll(o)
	for k,v in pairs(o) do
	if (k == "_G" or k == "coroutine"  or k == "utf8" or k == "math" or k == "package"  or k == "_type") then
	goto continue
	end
	
	print(k, " ~ ", type(v), "\n")
	
	if (type(v) == "table") then
	for tk,tv in pairs(v) do
	print(k, "::", tk, " ", type(tv), "=", tostring(ttv), "\n")
	
	if (type(tv) == "table") then
	for ttk,ttv in pairs(tv) do
	print(k, "::", tk, "::", ttk, " ", type(ttv), "=", tostring(ttv), "\n")
	
	if (type(ttv) == "table") then
	for tttk,tttv in pairs(ttv) do
	print(k, "::", tk, "::", ttk, "::", tttk, " ", type(tttv), "=", tostring(tttv), "\n")
	end
	end
	end
	end
	end
	end
	
	::continue::
	end
	end
	
	-- printAll(_G)
	
	print("AHA")

end




