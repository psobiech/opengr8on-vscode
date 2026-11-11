

function test()

--BEGIN_INIT
--END_INIT

	local text, pitch, step, y = "Witaj w domu! ", 7, 2, 27
	roll_px = ((roll_px or 0) + step) % (#text * pitch)
	local first, shift = roll_px // pitch, roll_px % pitch
	PAN3590:execute(2)
	for n = 0, 128 // pitch + 1 do
	local x, k = n * pitch - shift, (first + n) % #text + 1
	if x >= 0 and x < 128 and text:sub(k, k) ~= " " then PAN3590:execute(3, x, y, text:sub(k, k), 1) end
	end
	PAN3590:execute(29)
	
	print(CLU900000004:execute(0, "ZWA9300:get(0)"))
	
	CLU900000004:execute(0, "BUT6012:set(1, 0)")
	CLU900000004:execute(0, "BUT6012:set(1, 1)")
	

end




