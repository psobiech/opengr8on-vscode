local text, pitch, step, y = "Witaj w domu! ", 7, 2, 27                                                                                                                                                                          
  roll_px = ((roll_px or 0) + step) % (#text * pitch)                                                                                                                                                                              
  local first, shift = roll_px // pitch, roll_px % pitch                                                                                                                                                                           
  CLU900000006->x520093751_PANEL_01->ClearScreen()                                                                                                                                                                                
  for n = 0, 128 // pitch + 1 do                                                                                                                                                                                                   
    local x, k = n * pitch - shift, (first + n) % #text + 1                                                                                                                                                                        
    if x >= 0 and x < 128 and text:sub(k, k) ~= " " then CLU900000006->x520093751_PANEL_01->PrintText(x, y, text:sub(k, k), 1) end                                                                                                
  end                                                                                                                                                                                                                              
  CLU900000006->x520093751_PANEL_01->Draw() 
  
  print(CLU_1->IO_ZWA9300->State)
 
 CLU_1->IO_BUT6012->SetMode(0) 
 CLU_1->IO_BUT6012->Mode = 1
 