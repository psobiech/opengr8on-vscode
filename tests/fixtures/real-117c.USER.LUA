

function test()

--BEGIN_INIT
--END_INIT

	
	print(CLU900000005:execute(0, "ZWA9300:get(0)"))
	
	CLU900000005:execute(0, "BUT6012:set(1, 0)")
	CLU900000005:execute(0, "BUT6012:set(1, 1)")
	
	-- zażółć gęślą jaźń
	
	CLU900000005:execute(0, "elo2(nil)")
	
	nowy_skrypt("xxxx", 1, false)
	
	
	nowy_skrypt(nil, nil, nil)

end






function nowy_skrypt(parametr,dd,bbb)

--ARG parametr="domyslna"
--ARG dd=1 {1-10}
--ARG bbb=true
--BEGIN_INIT
	if parametr == nil then 
		parametr = "domyslna"
	end
	if dd == nil then 
		dd = 1
	end
	if bbb == nil then 
		bbb = true
	end
--END_INIT

	TIM8908:execute(0)

end






function aaaa()

--BEGIN_INIT
--END_INIT

	-- empty script

end




