

function test()

--BEGIN_INIT
--END_INIT

	
	print(CLU900000004:execute(0, "ZWA9300:get(0)"))
	
	CLU900000004:execute(0, "BUT6012:set(1, 0)")
	CLU900000004:execute(0, "BUT6012:set(1, 1)")
	
	-- zażółć gęślą jaźń
	
	CLU900000004:execute(0, "elo2(nil)")

end




